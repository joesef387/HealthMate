/* HealthMate API layer.
   Switch between the in-browser mock and the real backend with CONFIG below,
   or by defining window.HM_CONFIG = { USE_MOCK: false, API_BASE: "..." } before this file loads. */
(function () {
  "use strict";
  const CONFIG = Object.assign({
    USE_MOCK: false,
    API_BASE: "https://healthmate-adhc.onrender.com",
    GOOGLE_CLIENT_ID: "",
    FACEBOOK_APP_ID: ""
  }, window.HM_CONFIG || {});
  const TOKEN_KEY = "hm-token";
  const USER_KEY = "hm-user";
  let token = null, onUnauth = null;
  let currentUser = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {}
  try { currentUser = JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch (e) {}
  const setToken = (t) => {
    token = t;
    try {
      if (t) {
        localStorage.setItem(TOKEN_KEY, t);
      } else {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        currentUser = null;
      }
    } catch (e) {}
  };

  class ApiError extends Error {
    constructor(status, message, errors) { super(message); this.status = status; this.errors = errors || {}; }
  }
  function normErrors(e) {
    if (!e) return {};
    if (Array.isArray(e)) {
      const o = {};
      e.forEach((x) => {
        if (typeof x === "string") {
          o._form = o._form ? o._form + " " + x : x;
          return;
        }
        let k = x.field || x.path || (x.context && x.context.key);
        if (Array.isArray(k)) k = k[0];
        if (k) o[k] = x.message;
      });
      return o;
    }
    return e;
  }

  /* ---------- Normalisers: backend shape -> shape the UI uses ---------- */
  const list = (d, k) => (Array.isArray(d) ? d : (d && (d[k] || d.items || d.results)) || []);
  const one = (d, k) => (d && d[k]) || d;
  const toUser = (u) => ({ id: String(u.id || u._id || ""), fullName: u.fullName || u.name || "", email: u.email || "" });
  const toMed = (m) => ({ id: String(m.id || m._id), name: m.name, dose: m.dose || "", times: (m.times || []).slice(), remind: m.remind !== false });
  const toAct = (a) => ({
    id: String(a.id || a._id || ""),
    medId: String(a.medicationId || (a.medication && (a.medication._id || a.medication.id)) || a.medId || ""),
    name: a.medicationName || a.name || "Medication",
    dose: a.dose || a.medicationDose || "",
    day: String(a.date || a.day || "").slice(0, 10),
    time: a.time,
    takenAt: a.takenAt || null,
    missedAt: a.missedAt || null,
    s: a.status
  });

  /* ---------- Real backend ---------- */
  const browserTimeZone = () =>
    Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Lagos";

  const dateInTimeZone = (value, timeZone) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: timeZone || browserTimeZone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type).value;
    return part("year") + "-" + part("month") + "-" + part("day");
  };

  const timeInTimeZone = (value, timeZone) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone || browserTimeZone(),
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(date);
  };

  const dateAtTimeInTimeZone = (value, time, timeZone) => {
    const [year, month, day] = dateInTimeZone(value, timeZone)
      .split("-")
      .map(Number);
    const [hour, minute] = time.split(":").map(Number);
    let timestamp = Date.UTC(year, month - 1, day, hour, minute);
    const formatter = new Intl.DateTimeFormat("en", {
      timeZone: timeZone || browserTimeZone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = formatter.formatToParts(new Date(timestamp));
      const part = (type) =>
        Number(parts.find((item) => item.type === type).value);
      const actual = Date.UTC(
        part("year"),
        part("month") - 1,
        part("day"),
        part("hour"),
        part("minute")
      );
      const desired = Date.UTC(year, month - 1, day, hour, minute);
      timestamp += desired - actual;
    }

    return new Date(timestamp);
  };

  const fromBackendUser = (user) => ({
    id: String(user.id || user._id || ""),
    fullName: user.fullName || user.name || "",
    email: user.email || "",
    timeZone: user.timeZone || browserTimeZone()
  });

  function saveUser(user) {
    currentUser = fromBackendUser(user);
    try {
      localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
    } catch (e) {}
    return currentUser;
  }

  async function req(method, path, body, auth) {
    const headers = { "Content-Type": "application/json" };
    if (auth !== false && token) headers.Authorization = "Bearer " + token;
    let res;
    try {
      res = await fetch(CONFIG.API_BASE + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw new ApiError(0, "Can’t reach the server. Check your connection and try again.");
    }
    let json = null;
    try { json = await res.json(); } catch (e) {}
    if (!res.ok) {
      if (res.status === 401 && auth !== false && onUnauth) onUnauth();
      throw new ApiError(
        res.status,
        (json && (json.message || json.error)) || "Something went wrong. Please try again.",
        normErrors(json && json.errors)
      );
    }
    return json;
  }

  const medicationFromBackend = (medication, schedules) => {
    const activeSchedules = schedules.map((schedule) => ({
      id: String(schedule._id || schedule.id || ""),
      times: (schedule.scheduledTimes || schedule.times || []).slice().sort(),
      startDate: schedule.startDate
        ? String(schedule.startDate).slice(0, 10)
        : "",
      endDate: schedule.endDate
        ? String(schedule.endDate).slice(0, 10)
        : "",
      remind: schedule.remindersEnabled !== undefined
        ? schedule.remindersEnabled !== false
        : schedule.remind !== false,
      status: schedule.status || "active",
      deletedAt: schedule.deletedAt || null
    })).filter(
      (schedule) => schedule.status === "active" && !schedule.deletedAt
    );
    const times = Array.from(
      new Set(activeSchedules.flatMap((schedule) => schedule.times))
    ).sort();
    return {
      id: String(medication._id || medication.id || ""),
      name: medication.medicationName || medication.name || "",
      dose: medication.dosageDetails || medication.dose || "",
      times,
      remind: activeSchedules.length > 0 &&
        activeSchedules.every((schedule) => schedule.remind),
      schedules: activeSchedules
    };
  };

  const fetchMedicationSchedules = async (medicationId) => {
    const response = await req(
      "GET",
      "/api/medications/" + encodeURIComponent(medicationId) + "/schedules"
    );
    return response.data && response.data.schedules || [];
  };

  const createBackendSchedule = (medicationId, time, remind, template) =>
    req(
      "POST",
      "/api/medications/" + encodeURIComponent(medicationId) + "/schedules",
      {
        frequency: template && template.frequency || "Daily",
        scheduledTimes: [time],
        startDate: template && template.startDate
          ? String(template.startDate).slice(0, 10)
          : dateInTimeZone(new Date(), currentUser && currentUser.timeZone),
        endDate: template && template.endDate
          ? String(template.endDate).slice(0, 10)
          : null,
        remindersEnabled: remind,
        status: "active"
      }
    );

  const dateTimeForLog = (recordedAt) => {
    const value = recordedAt || new Date().toISOString();
    return {
      day: dateInTimeZone(value, currentUser && currentUser.timeZone),
      time: timeInTimeZone(value, currentUser && currentUser.timeZone)
    };
  };

  const activityFromBackend = (log) => {
    const schedule = log.scheduleId && typeof log.scheduleId === "object"
      ? log.scheduleId
      : null;
    const medication = schedule && schedule.medicationId &&
      typeof schedule.medicationId === "object"
      ? schedule.medicationId
      : null;
    const recordedAt = log.recordedAt || new Date().toISOString();
    const recorded = dateTimeForLog(recordedAt);
    const scheduledTimes = schedule && schedule.scheduledTimes || [];
    const scheduledTime = scheduledTimes.length === 1
      ? scheduledTimes[0]
      : "";
    const status = log.activityStatus || log.status;

    return {
      id: String(log._id || log.id || ""),
      scheduleId: String(
        schedule ? schedule._id || schedule.id : log.scheduleId || ""
      ),
      medId: String(
        medication ? medication._id || medication.id : ""
      ),
      name: medication
        ? medication.medicationName || medication.name || "Medication"
        : "Medication",
      dose: medication
        ? medication.dosageDetails || medication.dose || ""
        : "",
      day: recorded.day,
      time: scheduledTime || recorded.time,
      scheduledTime,
      scheduledTimes: scheduledTimes.slice(),
      recordedAt,
      takenAt: status === "taken" ? recordedAt : null,
      missedAt: status === "missed" ? recordedAt : null,
      s: status
    };
  };

  const real = {
    async register(p) {
      const response = await req(
        "POST",
        "/auth/register",
        {
          name: p.fullName,
          email: p.email,
          password: p.password,
          timeZone: browserTimeZone()
        },
        false
      );
      setToken(response.token);
      return saveUser(response.user);
    },
    async login(p) {
      const response = await req("POST", "/auth/login", p, false);
      setToken(response.token);
      return saveUser(response.user);
    },
    async googleLogin() {
      throw new ApiError(501, "Google sign-in is not available on the HealthMate backend yet.");
    },
    async facebookLogin() {
      throw new ApiError(501, "Facebook sign-in is not available on the HealthMate backend yet.");
    },
    async me() {
      if (!currentUser || !currentUser.id) {
        throw new ApiError(401, "Please sign in again to continue.");
      }
      const response = await req(
        "GET",
        "/auth/me/" + encodeURIComponent(currentUser.id)
      );
      return saveUser(response.user || response);
    },
    async logout() {
      setToken(null);
    },
    async listMeds() {
      const response = await req("GET", "/api/medications");
      const medications = response.data && response.data.medications || [];
      const results = await Promise.all(
        medications.map(async (medication) =>
          medicationFromBackend(
            medication,
            await fetchMedicationSchedules(medication._id)
          )
        )
      );
      return results.filter((medication) => medication.times.length > 0);
    },
    async createMed(medication) {
      const response = await req("POST", "/api/medications", {
        medicationName: medication.name,
        dosageDetails: medication.dose
      });
      const savedMedication = response.data && response.data.medication;
      const createdSchedules = [];

      // Separate schedules let each dose log identify one scheduled time.
      try {
        for (const time of medication.times) {
          const created = await createBackendSchedule(
            savedMedication._id,
            time,
            medication.remind
          );
          createdSchedules.push(created.data.schedule);
        }
      } catch (error) {
        let cleanupFailed = false;
        for (const schedule of createdSchedules) {
          try {
            await req(
              "DELETE",
              "/api/medication-schedules/" +
                encodeURIComponent(schedule._id)
            );
          } catch (cleanupError) {
            cleanupFailed = true;
          }
        }
        throw new ApiError(
          error.status || 500,
          "The medication was created, but its schedule could not be saved: " +
            error.message +
            (cleanupFailed
              ? " Some schedules may still be active."
              : " The medication record remains on the backend."),
          error.errors
        );
      }

      return medicationFromBackend(savedMedication, createdSchedules);
    },
    async updateMed(id, medication) {
      const response = await req(
        "PATCH",
        "/api/medications/" + encodeURIComponent(id),
        {
          medicationName: medication.name,
          dosageDetails: medication.dose
        }
      );
      const savedMedication = response.data && response.data.medication;
      const schedules = await fetchMedicationSchedules(id);
      const activeSchedules = schedules.filter(
        (schedule) => schedule.status === "active" && !schedule.deletedAt
      );
      const retained = new Set();
      const desiredTimes = Array.from(new Set(medication.times)).sort();
      const createdSchedules = [];
      const reminderUpdates = [];

      try {
        for (const time of desiredTimes) {
          const existing = activeSchedules.find(
            (schedule) =>
              !retained.has(String(schedule._id)) &&
              schedule.scheduledTimes.length === 1 &&
              schedule.scheduledTimes[0] === time
          );
          if (existing) {
            retained.add(String(existing._id));
            if (existing.remindersEnabled !== medication.remind) {
              reminderUpdates.push(existing._id);
            }
          } else {
            const template = activeSchedules.find(
              (schedule) => schedule.scheduledTimes.includes(time)
            ) || activeSchedules[0];
            const created = await createBackendSchedule(
              id,
              time,
              medication.remind,
              template
            );
            createdSchedules.push(created.data.schedule);
            retained.add(String(created.data.schedule._id));
          }
        }
      } catch (error) {
        let cleanupFailed = false;
        for (const schedule of createdSchedules) {
          try {
            await req(
              "DELETE",
              "/api/medication-schedules/" +
                encodeURIComponent(schedule._id)
            );
          } catch (cleanupError) {
            cleanupFailed = true;
          }
        }
        throw new ApiError(
          error.status || 500,
          "Medication details were updated, but the new schedule could not be saved: " +
            error.message +
            (cleanupFailed ? " Some new schedules may still be active." : ""),
          error.errors
        );
      }

      for (const scheduleId of reminderUpdates) {
        await req(
          "PATCH",
          "/api/medication-schedules/" +
            encodeURIComponent(scheduleId),
          { remindersEnabled: medication.remind }
        );
      }

      const removedSchedules = activeSchedules.filter(
        (schedule) => !retained.has(String(schedule._id))
      );
      await Promise.all(
        removedSchedules.map((schedule) =>
          req(
            "DELETE",
            "/api/medication-schedules/" +
              encodeURIComponent(schedule._id)
          )
        )
      );

      return medicationFromBackend(
        savedMedication,
        activeSchedules
          .filter((schedule) => retained.has(String(schedule._id)))
          .concat(createdSchedules)
          .map((schedule) => ({
            ...schedule,
            remindersEnabled: medication.remind,
            status: "active",
            deletedAt: null
          }))
      );
    },
    async deleteMed(medicationId) {
      const schedules = await fetchMedicationSchedules(medicationId);
      const activeSchedules = schedules.filter(
        (schedule) => schedule.status === "active" && !schedule.deletedAt
      );
      await Promise.all(
        activeSchedules.map((schedule) =>
          req(
            "DELETE",
            "/api/medication-schedules/" +
              encodeURIComponent(schedule._id)
          )
        )
      );
    },
    async listActivity(from, to) {
      const response = await req("GET", "/api/medication-logs");
      const records = (response.data && response.data.medicationLogs || [])
        .map(activityFromBackend)
        .filter((record) => record.s === "taken" || record.s === "missed")
        .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
      return records.filter((record) => record.day >= from && record.day <= to);
    },
    async setActivity(record) {
      const response = await req(
        "POST",
        "/api/medication-schedules/" +
          encodeURIComponent(record.scheduleId) +
          "/logs",
        { activityStatus: record.status }
      );
      const saved = response.data && response.data.medicationLog;
      const recordedAt = saved.recordedAt || new Date().toISOString();
      const recorded = dateTimeForLog(recordedAt);
      return {
        id: String(saved._id || ""),
        scheduleId: record.scheduleId,
        medId: record.medicationId,
        name: record.name,
        dose: record.dose,
        day: recorded.day,
        time: record.time,
        recordedAt,
        takenAt: record.status === "taken" ? recordedAt : null,
        missedAt: record.status === "missed" ? recordedAt : null,
        s: record.status
      };
    },
    async deleteActivity() {
      throw new ApiError(501, "The backend does not support editing or deleting dose logs.");
    }
  };

  /* ---------- Mock backend (same contract, stored in this browser) ---------- */
  const mock = (function () {
    const KEY = "hm-mock-db", pad = (n) => (n < 10 ? "0" + n : "" + n);
    const dk = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    function seed() {
      const meds = [
        { id: "m1", uid: "u1", name: "Vitamin D3", dose: "1000 IU, 1 tablet", times: ["07:30"], remind: true },
        { id: "m2", uid: "u1", name: "Amoxicillin", dose: "500 mg, 1 capsule", times: ["12:00", "20:00"], remind: true },
        { id: "m3", uid: "u1", name: "Iron", dose: "65 mg, 1 tablet", times: ["15:00"], remind: true },
        { id: "m4", uid: "u1", name: "Magnesium", dose: "200 mg, 1 tablet", times: ["22:00"], remind: false }
      ];
      const act = [], now = new Date();
      for (let i = 27; i >= 1; i--) {
        const day = dk(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
        meds.forEach((m) => m.times.forEach((t, ti) => {
          act.push({ id: "a" + act.length, uid: "u1", medId: m.id, name: m.name, dose: m.dose, day, time: t, s: (i * 3 + +m.id.slice(1) + ti) % 7 === 0 ? "missed" : "taken" });
        }));
      }
      return { users: [{ id: "u1", fullName: "Ama Mensah", email: "demo@healthmate.app", password: "healthmate1" }], meds, act, n: 100 };
    }
    let db = null;
    try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    if (!db) db = seed();
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} };
    const wait = (v) => new Promise((r) => setTimeout(() => r(JSON.parse(JSON.stringify(v === undefined ? null : v))), 150));
    const fail = (s, m, e) => new Promise((_, rej) => setTimeout(() => rej(new ApiError(s, m, e)), 150));
    const uidOf = () => (token && token.indexOf("mock-") === 0 ? token.slice(5) : null);
    const pub = (u) => ({ id: u.id, fullName: u.fullName, email: u.email });
    const me = () => db.users.filter((u) => u.id === uidOf())[0];
    const guard = () => { if (!me()) { if (onUnauth) onUnauth(); return false; } return true; };
    const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    return {
      register(p) {
        const e = {};
        if (!p.fullName || p.fullName.trim().length < 2) e.fullName = "Enter your full name.";
        if (!EMAIL.test(p.email || "")) e.email = "Enter a valid email address.";
        if (!p.password || p.password.length < 8) e.password = "Use at least 8 characters.";
        if (Object.keys(e).length) return fail(400, "Please fix the highlighted fields.", e);
        const email = p.email.toLowerCase();
        if (db.users.some((u) => u.email === email)) return fail(409, "An account with this email already exists.", { email: "An account with this email already exists." });
        const u = { id: "u" + db.n++, fullName: p.fullName.trim(), email, password: p.password };
        db.users.push(u); save(); setToken("mock-" + u.id); return wait(pub(u));
      },
      login(p) {
        const u = db.users.filter((x) => x.email === (p.email || "").toLowerCase() && x.password === p.password)[0];
        if (!u) return fail(401, "Incorrect email or password.");
        setToken("mock-" + u.id); return wait(pub(u));
      },
      googleLogin() {
        const u = db.users[0];
        if (!u) return fail(401, "Google sign-in is unavailable.");
        setToken("mock-" + u.id);
        return wait({ id: u.id, fullName: "Joseph Arthur", email: "josefarthur387@gmail.com" });
      },
      facebookLogin() {
        const u = db.users[0];
        if (!u) return fail(401, "Facebook sign-in is unavailable.");
        setToken("mock-" + u.id);
        return wait({ id: u.id, fullName: "Joseph Arthur", email: "josefarthur387@gmail.com" });
      },
      me() { const u = me(); return u ? wait(pub(u)) : fail(401, "Not logged in."); },
      logout() { setToken(null); return wait(null); },
      clearLocalData() {
        try {
          localStorage.removeItem(KEY);
          localStorage.removeItem(TOKEN_KEY);
          if (localStorage.getItem(KEY) !== null || localStorage.getItem(TOKEN_KEY) !== null) throw new Error("Storage was not cleared.");
        } catch (e) {
          return fail(0, "Could not clear demo data from this browser. Check storage permissions and try again.");
        }
        db = seed();
        token = null;
        return wait(null);
      },
      listMeds() { if (!guard()) return fail(401, "Not logged in."); return wait(db.meds.filter((m) => m.uid === uidOf()).map(toMed)); },
      createMed(m) {
        if (!guard()) return fail(401, "Not logged in.");
        const x = { id: "m" + db.n++, uid: uidOf(), name: m.name, dose: m.dose, times: m.times, remind: m.remind !== false };
        db.meds.push(x); save(); return wait(toMed(x));
      },
      updateMed(id, m) {
        const x = db.meds.filter((y) => y.id === id && y.uid === uidOf())[0];
        if (!x) return fail(404, "Medication not found.");
        Object.assign(x, { name: m.name, dose: m.dose, times: m.times, remind: m.remind !== false }); save(); return wait(toMed(x));
      },
      deleteMed(id) { db.meds = db.meds.filter((y) => !(y.id === id && y.uid === uidOf())); save(); return wait(null); },
      listActivity(from, to) {
        if (!guard()) return fail(401, "Not logged in.");
        return wait(db.act.filter((a) => a.uid === uidOf() && a.day >= from && a.day <= to));
      },
      setActivity(r) {
        const uid = uidOf(), med = db.meds.filter((m) => m.id === r.medicationId)[0];
        let a = db.act.filter((x) => x.uid === uid && x.medId === r.medicationId && x.day === r.date && x.time === r.time)[0];
        if (a) {
          a.s = r.status;
          a.takenAt = r.takenAt || null;
          a.missedAt = r.missedAt || null;
        } else {
          a = { id: "a" + db.n++, uid, medId: r.medicationId, name: med ? med.name : "Medication", dose: med ? med.dose : "", day: r.date, time: r.time, takenAt: r.takenAt || null, missedAt: r.missedAt || null, s: r.status };
          db.act.push(a);
        }
        save(); return wait(a);
      },
      deleteActivity(id) { db.act = db.act.filter((a) => a.id !== id); save(); return wait(null); }
    };
  })();

  const impl = CONFIG.USE_MOCK ? mock : real;
  window.HM_API = Object.assign({
    CONFIG, ApiError,
    canUndoActivity: CONFIG.USE_MOCK,
    dateKey: (date) =>
      CONFIG.USE_MOCK
        ? date.getFullYear() + "-" +
          String(date.getMonth() + 1).padStart(2, "0") + "-" +
          String(date.getDate()).padStart(2, "0")
        : dateInTimeZone(date, currentUser && currentUser.timeZone),
    dateAtTime: (date, time) => {
      if (CONFIG.USE_MOCK) {
        const result = new Date(date);
        const [hour, minute] = time.split(":").map(Number);
        result.setHours(hour, minute, 0, 0);
        return result;
      }
      return dateAtTimeInTimeZone(
        date,
        time,
        currentUser && currentUser.timeZone
      );
    },
    formatDateTime: (value, options) =>
      new Date(value).toLocaleString(undefined, Object.assign(
        { timeZone: currentUser && currentUser.timeZone || browserTimeZone() },
        options || {}
      )),
    hasSession: () => !!token,
    setUnauthorizedHandler: (fn) => { onUnauth = fn; }
  }, impl);
})();