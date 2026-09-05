const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

// Polish plural form picker: forms = [one, few (2-4), many (5+/0)].
function plForm(n, forms) {
  if (n === 1) return forms[0];
  const mod10 = n % 10, mod100 = n % 100;
  return (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) ? forms[1] : forms[2];
}

const STRINGS = {
  en: {
    onceTaskBody: (text) => `Reminder: "${text}"`,
    recurringTaskBody: (text) => `Time again for: "${text}"`,
    habitBody: (n) => (n === 1 ? "You still have 1 habit left today." : `You still have ${n} habits left today.`),
    morningNudge: (habitCount, pendingCount) => {
      const parts = [];
      if (habitCount > 0) parts.push(habitCount === 1 ? "1 habit" : `${habitCount} habits`);
      if (pendingCount > 0) parts.push(pendingCount === 1 ? "1 task" : `${pendingCount} tasks`);
      if (!parts.length) return null;
      return `Good morning! You have ${parts.join(" and ")} waiting for you today.`;
    },
    partnerAdded: (name, text) => `${name} added: "${text}"`,
    partnerUnhid: (name, text) => `${name} shared a task with you: "${text}"`,
    partnerCompleted: (name, text) => `${name} checked off: "${text}"`
  },
  pl: {
    onceTaskBody: (text) => `Przypomnienie: „${text}”`,
    recurringTaskBody: (text) => `Znów czas na: „${text}”`,
    habitBody: (n) => `Został${n === 1 ? "" : "o"} Ci jeszcze ${n} nieodhaczon${n === 1 ? "y" : "ych"} ${plForm(n, ["nawyk", "nawyki", "nawyków"])} dzisiaj.`,
    morningNudge: (habitCount, pendingCount) => {
      const parts = [];
      if (habitCount > 0) parts.push(`${habitCount} ${plForm(habitCount, ["nawyk", "nawyki", "nawyków"])}`);
      if (pendingCount > 0) parts.push(`${pendingCount} ${plForm(pendingCount, ["zadanie", "zadania", "zadań"])}`);
      if (!parts.length) return null;
      return `Dzień dobry! Masz dziś do zrobienia: ${parts.join(" i ")}.`;
    },
    partnerAdded: (name, text) => `${name} dodał(a): „${text}”`,
    partnerUnhid: (name, text) => `${name} odkrył(a) dla Ciebie zadanie: „${text}”`,
    partnerCompleted: (name, text) => `${name} odhaczył(a): „${text}”`
  }
};

function strings(lang) {
  return STRINGS[lang] || STRINGS.en;
}

// -- time-zone helpers, ported from the client (index.html) so the two never
// drift apart in how they compute "today" / "due at" for a given person --

function todayStrFor(date, zone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch (e) {
    return date.toISOString().slice(0, 10);
  }
}

// Converts a wall-clock date+time as seen in a given IANA zone into the
// matching UTC timestamp. Ported from index.html's zonedTimeToUtcMs so the
// two never drift apart; verified against DST transitions in both directions.
function zonedTimeToUtcMs(dateStr, timeStr, zone) {
  const [y, mo, da] = dateStr.split("-").map(Number);
  const [h, mi] = (timeStr || "00:00").split(":").map(Number);
  const target = Date.UTC(y, mo - 1, da, h, mi, 0);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      }).formatToParts(new Date(guess));
      const map = {};
      for (const p of parts) map[p.type] = p.value;
      const hour = map.hour === "24" ? 0 : Number(map.hour);
      const shown = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second));
      guess -= (shown - target);
    } catch (e) { break; }
  }
  return guess;
}

// A task's ownerEmail is the literal string "shared" for tasks living in a
// shared custom list (no single owner) - reminders there go to everyone who
// can see the list instead of to a single (nonexistent) "shared" account.
function recipientsFor(task) {
  if (task.ownerEmail === "shared") return task.members || [];
  return [task.ownerEmail];
}

async function getUiState(email) {
  const snap = await db.doc(`ui_state/${email}`).get();
  return snap.exists ? snap.data() : {};
}

async function displayNameFor(email) {
  try {
    const snap = await db.doc(`allowed_users/${email}`).get();
    return (snap.exists && snap.data().name) || email;
  } catch (e) {
    return email;
  }
}

// Mirrors the client/rules roleOnList(): the list owner is always an editor;
// anyone else defaults to editor too (legacy partner-shared lists never set
// roles) unless the list's roles map explicitly names them a viewer. A
// viewer only ever looks - they can't act on a new/changed task - so
// activity notifications skip them regardless of which relationship
// (partner or a point-11 invite) put them on the list.
async function roleOnListForEmail(listId, email) {
  if (!listId) return "editor";
  try {
    const snap = await db.doc(`custom_lists/${listId}`).get();
    if (!snap.exists) return "editor";
    const list = snap.data();
    if (list.ownerEmail === email) return "editor";
    return (list.roles && list.roles[email]) || "editor";
  } catch (e) {
    return "editor";
  }
}

async function filterOutViewers(emails, listId) {
  const kept = [];
  for (const email of emails) {
    if ((await roleOnListForEmail(listId, email)) !== "viewer") kept.push(email);
  }
  return kept;
}

// Sends a push to every device registered for `email`, respecting their
// notification prefs, and prunes any tokens FCM reports as dead.
async function sendToUser(email, notification, notifTypeKey) {
  const data = await getUiState(email);
  const notif = data.notif || {};
  if (!notif.enabled) return;
  if (notifTypeKey && notif[notifTypeKey] === false) return;
  const tokens = notif.tokens || [];
  if (!tokens.length) return;

  const invalid = [];
  await Promise.all(tokens.map(async (token) => {
    try {
      await messaging.send({ token, notification, webpush: { fcmOptions: { link: "./index.html" } } });
    } catch (e) {
      const code = e && e.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-argument") {
        invalid.push(token);
      }
    }
  }));

  if (invalid.length) {
    await db.doc(`ui_state/${email}`).set({ notif: { tokens: FieldValue.arrayRemove(...invalid) } }, { merge: true });
  }
}

// ---- 1) Scheduled task reminders (once + recurring, with a time set) ----

exports.remindScheduledTasks = onSchedule("every 5 minutes", async () => {
  const now = Date.now();
  const windowStart = now - 5 * 60 * 1000;

  const onceSnap = await db.collection("tasks")
    .where("schedule.type", "==", "once")
    .where("schedule.dueAtMs", "<=", now)
    .where("schedule.dueAtMs", ">", windowStart)
    .get();

  for (const docSnap of onceSnap.docs) {
    const task = docSnap.data();
    if (task.done || task.deleted || task.schedule.notifiedAt) continue;
    for (const email of recipientsFor(task)) {
      const uiState = await getUiState(email);
      const body = strings(uiState.lang).onceTaskBody(task.text);
      await sendToUser(email, { title: "DoDaily", body }, "taskReminders");
    }
    await docSnap.ref.update({ "schedule.notifiedAt": now });
  }

  const recurringSnap = await db.collection("tasks")
    .where("schedule.type", "==", "recurring")
    .where("schedule.renewsAt", "<=", now)
    .where("schedule.renewsAt", ">", windowStart)
    .get();

  for (const docSnap of recurringSnap.docs) {
    const task = docSnap.data();
    if (task.deleted || task.schedule.notifiedAt === task.schedule.renewsAt) continue;
    for (const email of recipientsFor(task)) {
      const uiState = await getUiState(email);
      const body = strings(uiState.lang).recurringTaskBody(task.text);
      await sendToUser(email, { title: "DoDaily", body }, "taskReminders");
    }
    await docSnap.ref.update({ "schedule.notifiedAt": task.schedule.renewsAt });
  }
});

// ---- 2) Daily habit reminder - fixed at 08:00 and 18:00 local time. The
// morning slot also nudges about any other pending (non-habit) tasks, so
// people don't forget to open the app even on days with no habits due. ----

const REMINDER_TIMES = ["08:00", "18:00"];

function isTaskPending(task, nowMs) {
  if (task.deleted || task.isHabit) return false;
  if (task.schedule && task.schedule.type === "recurring") {
    return !(task.schedule.renewsAt && task.schedule.renewsAt > nowMs);
  }
  return !task.done;
}

exports.remindHabits = onSchedule("every 15 minutes", async () => {
  const now = new Date();
  const usersSnap = await db.collection("ui_state").get();

  for (const userDoc of usersSnap.docs) {
    const email = userDoc.id;
    const data = userDoc.data();
    const notif = data.notif || {};
    if (!notif.enabled || notif.habitReminder === false) continue;

    const tz = data.timeZone || "UTC";
    const today = todayStrFor(now, tz);

    for (const time of REMINDER_TIMES) {
      const slotKey = today + "_" + time;
      if (notif.lastHabitReminderSlot === slotKey) continue;

      // A 15-minute window matching the schedule's own cadence, rather than
      // an exact "HH:MM === HH:MM" string match - the scheduler tick
      // essentially never lands on the exact same minute as the target.
      const targetMs = zonedTimeToUtcMs(today, time, tz);
      if (now.getTime() < targetMs || now.getTime() >= targetMs + 15 * 60 * 1000) continue;

      const tasksSnap = await db.collection("tasks").where("ownerEmail", "==", email).get();
      const incompleteHabits = tasksSnap.docs.filter((d) => {
        const task = d.data();
        if (!task.isHabit || task.hidden || task.deleted) return false;
        return !(task.completedDates || []).includes(today);
      });

      let body = null;
      if (time === "08:00") {
        const pendingCount = tasksSnap.docs.filter((d) => isTaskPending(d.data(), now.getTime())).length;
        body = strings(data.lang).morningNudge(incompleteHabits.length, pendingCount);
      } else if (incompleteHabits.length > 0) {
        body = strings(data.lang).habitBody(incompleteHabits.length);
      }

      if (body) await sendToUser(email, { title: "DoDaily", body });
      await userDoc.ref.set({ notif: { lastHabitReminderSlot: slotKey } }, { merge: true });
    }
  }
});

// ---- 3) Partner activity: new shared task, unhidden task, completed task ----

exports.notifyPartnerOnTaskCreate = onDocumentCreated("tasks/{taskId}", async (event) => {
  const task = event.data.data();
  if (task.hidden || !task.members || task.members.length < 2) return;
  const recipients = await filterOutViewers(task.members.filter((email) => email !== task.createdByEmail), task.customListId);
  if (!recipients.length) return;
  const actorName = await displayNameFor(task.createdByEmail);
  for (const email of recipients) {
    const uiState = await getUiState(email);
    const body = strings(uiState.lang).partnerAdded(actorName, task.text);
    await sendToUser(email, { title: "DoDaily", body }, "partnerActivity");
  }
});

exports.notifyPartnerOnTaskUpdate = onDocumentUpdated("tasks/{taskId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (after.deleted || !after.members || after.members.length < 2) return;

  if (before.hidden === true && after.hidden === false) {
    const recipients = await filterOutViewers(after.members.filter((email) => email !== after.ownerEmail), after.customListId);
    if (recipients.length) {
      const actorName = await displayNameFor(after.ownerEmail);
      for (const email of recipients) {
        const uiState = await getUiState(email);
        const body = strings(uiState.lang).partnerUnhid(actorName, after.text);
        await sendToUser(email, { title: "DoDaily", body }, "partnerActivity");
      }
    }
  }

  if (!after.isHabit && before.done === false && after.done === true && after.lastModifiedByEmail) {
    const actor = after.lastModifiedByEmail;
    const recipients = await filterOutViewers(after.members.filter((email) => email !== actor), after.customListId);
    if (recipients.length) {
      const actorName = await displayNameFor(actor);
      for (const email of recipients) {
        const uiState = await getUiState(email);
        const body = strings(uiState.lang).partnerCompleted(actorName, after.text);
        await sendToUser(email, { title: "DoDaily", body }, "partnerActivity");
      }
    }
  }
});
