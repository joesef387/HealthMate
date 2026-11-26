(function () {
  "use strict";

  // =====================================================
  // 1. INITIALIZATION
  // =====================================================

  const api = window.HM_API;
  const $ = (id) => document.getElementById(id);
  const each = (selector, fn) =>
    document.querySelectorAll(selector).forEach(fn);

  if (!api) {
    console.error("HealthMate API is not loaded. Check api.js.");
    return;
  }

  const C = 2 * Math.PI * 52;
  const REMINDER_GRACE_MS = 5 * 60 * 1000;

  const DEFAULT_TIMES = {
    1: ["08:00"],
    2: ["08:00", "20:00"],
    3: ["08:00", "14:00", "20:00"]
  };

  let undoFn = null;
  let toastTimer = null;
  let editId = null;
  let user = null;

  let meds = [];
  let activity = [];

  const fired = new Set();
  const pendingDoses = new Set();

  const pad = (n) => String(n).padStart(2, "0");

  const dk = (date) =>
    api.dateKey
      ? api.dateKey(date)
      : date.getFullYear() +
        "-" +
        pad(date.getMonth() + 1) +
        "-" +
        pad(date.getDate());

  const parseDay = (value) => {
    const parts = value.split("-");
    return new Date(+parts[0], +parts[1] - 1, +parts[2]);
  };

  const at = (dose) => {
    if (api.dateAtTime) {
      return api.dateAtTime(new Date(), hm(dose));
    }

    const date = new Date();
    date.setHours(dose.h, dose.m, 0, 0);
    return date;
  };

  const hm = (dose) =>
    pad(dose.h) + ":" + pad(dose.m);

  const dateTimeLabel = (value) => {
    if (!value) return null;

    const date = new Date(value);

    return Number.isNaN(date.getTime())
      ? null
      : api.formatDateTime
        ? api.formatDateTime(date, {
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit"
        })
        : date.toLocaleString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit"
          });
  };

  const span = (milliseconds) => {
    const minutes = Math.round(Math.abs(milliseconds) / 60000);
    const hours = Math.floor(minutes / 60);

    return hours
      ? hours + "h " + pad(minutes % 60) + "m"
      : minutes + "m";
  };

  const errMsg = (error) =>
    (error && error.message) ||
    "Something went wrong. Please try again.";

  const safeElement = (id) => {
    const element = $(id);

    if (!element) {
      console.warn("HealthMate: Missing HTML element:", id);
    }

    return element;
  };

  // Optional demo privacy notice.
  const demoPrivacy = $("demo-privacy");

  if (demoPrivacy && api.CONFIG) {
    demoPrivacy.hidden = !api.CONFIG.USE_MOCK;
  }

  // =====================================================
  // 2. TOAST NOTIFICATIONS
  // =====================================================

  function toast(message, undoCallback) {
    const toastBox = $("toast");

    if (!toastBox) return;

    $("toast-msg").textContent = message;

    undoFn = undoCallback || null;

    $("undo").hidden = !undoCallback;

    toastBox.classList.add("show");

    clearTimeout(toastTimer);

    toastTimer = setTimeout(hideToast, 5000);
  }

  function hideToast() {
    $("toast").classList.remove("show");
    undoFn = null;
  }

  $("undo").onclick = async () => {
    const callback = undoFn;

    hideToast();

    if (callback) {
      try {
        await callback();
      } catch (error) {
        toast(errMsg(error));
      }
    }
  };

  // =====================================================
  // 3. MEDICATION DATA
  // =====================================================

  function buildDoses() {
    const today = dk(new Date());
    const records = {};

    activity.forEach((item) => {
      if (item.day === today) {
        const key =
          item.medId +
          "@" +
          item.time +
          "@" +
          (item.scheduleId || "");
        records[key] = item;
      }
    });

    const output = [];

    meds.forEach((med) => {
      (med.times || []).forEach((time) => {
        const schedule = (med.schedules || []).find(
          (item) => item.times.includes(time)
        );
        if (med.schedules && !schedule) return;
        if (
          schedule &&
          ((schedule.startDate && today < schedule.startDate) ||
            (schedule.endDate && today > schedule.endDate))
        ) {
          return;
        }

        const parts = time.split(":");
        const key = med.id + "@" + time;

        const record =
          records[key + "@" + (schedule ? schedule.id : "")] ||
          records[key + "@"];

        output.push({
          key,
          medId: med.id,
          scheduleId: schedule ? schedule.id : "",
          remind: schedule ? schedule.remind : med.remind,
          name: med.name,
          dose: med.dose,
          h: Number(parts[0]),
          m: Number(parts[1]),
          s: record ? record.s : null
        });
      });
    });

    return output.sort(
      (a, b) =>
        a.h * 60 + a.m -
        (b.h * 60 + b.m)
    );
  }

  async function loadAll() {
    const today = new Date();

    const from = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - 27
    );

    const results = await Promise.all([
      api.listMeds(),
      api.listActivity(dk(from), dk(today))
    ]);

    meds = Array.isArray(results[0]) ? results[0] : [];
    activity = Array.isArray(results[1]) ? results[1] : [];
  }

  // =====================================================
  // 4. DOSE TRACKING
  // =====================================================

  async function setS(key, status) {
    if (pendingDoses.has(key)) {
      toast("This dose is already being updated.");
      return;
    }

    const dose = buildDoses().find(
      (item) => item.key === key
    );

    if (!dose) return;

    const today = dk(new Date());

    const record = activity.find(
      (item) =>
        item.day === today &&
        item.medId + "@" + item.time === key &&
        (!item.scheduleId ||
          !dose.scheduleId ||
          item.scheduleId === dose.scheduleId)
    );

    const previousStatus = record ? record.s : null;
    const previousTakenAt = record ? record.takenAt : null;
    const previousMissedAt = record ? record.missedAt : null;
    const statusAt =
      status === "taken" || status === "missed"
        ? new Date().toISOString()
        : null;
    const takenAt = status === "taken" ? statusAt : null;
    const missedAt = status === "missed" ? statusAt : null;

    const newRecord = record || {
      id: "",
      medId: dose.medId,
      scheduleId: dose.scheduleId,
      name: dose.name,
      dose: dose.dose,
      day: today,
      time: hm(dose),
      takenAt: null,
      missedAt: null,
      s: null
    };

    if (!record) {
      activity.push(newRecord);
    }

    newRecord.s = status;
    newRecord.takenAt = takenAt;
    newRecord.missedAt = missedAt;

    pendingDoses.add(key);

    render();

    const savePromise = api.setActivity({
      medicationId: dose.medId,
      scheduleId: dose.scheduleId,
      date: today,
      time: hm(dose),
      name: dose.name,
      dose: dose.dose,
      status,
      takenAt,
      missedAt
    });

    let savedSuccessfully = false;

    try {
      const saved = await savePromise;

      newRecord.id = saved.id || newRecord.id;
      newRecord.day = saved.day || today;
      newRecord.time = saved.time || hm(dose);
      newRecord.recordedAt = saved.recordedAt || statusAt;
      newRecord.takenAt = saved.takenAt || takenAt;
      newRecord.missedAt = saved.missedAt || missedAt;

      savedSuccessfully = true;

    } catch (error) {
      restoreRecord(
        newRecord,
        previousStatus,
        previousTakenAt,
        previousMissedAt
      );
      toast(errMsg(error));
      return;

    } finally {
      pendingDoses.delete(key);
      render();
    }

    if (!savedSuccessfully) return;

    toast(
      dose.name + " marked as " + status,
      api.canUndoActivity ? async () => {
        if (previousStatus) {
          const result = await api.setActivity({
            medicationId: dose.medId,
            scheduleId: dose.scheduleId,
            date: today,
            time: hm(dose),
            name: dose.name,
            dose: dose.dose,
            status: previousStatus,
            takenAt: previousTakenAt,
            missedAt: previousMissedAt
          });

          newRecord.s = previousStatus;
          newRecord.takenAt = result.takenAt || previousTakenAt;
          newRecord.missedAt = result.missedAt || previousMissedAt;
          newRecord.id = result.id || newRecord.id;

        } else {
          if (newRecord.id) {
            await api.deleteActivity(newRecord.id);
          }

          restoreRecord(newRecord, null, null, null);
        }

        render();
        toast("Dose record updated.");
      } : undefined
    );
  }

  function restoreRecord(
    record,
    previousStatus,
    previousTakenAt,
    previousMissedAt
  ) {
    if (previousStatus) {
      record.s = previousStatus;
      record.takenAt = previousTakenAt;
      record.missedAt = previousMissedAt;
    } else {
      const index = activity.indexOf(record);

      if (index !== -1) {
        activity.splice(index, 1);
      }
    }

    render();
  }

  // =====================================================
  // 5. DASHBOARD
  // =====================================================

  function render() {
    if (!user) return;

    const doses = buildDoses();
    const now = new Date();
    const hour = now.getHours();

    $("greet").textContent =
      (hour < 12
        ? "Good morning"
        : hour < 17
          ? "Good afternoon"
          : "Good evening") +
      (user.fullName
        ? ", " + user.fullName.split(" ")[0]
        : "");

    $("date").textContent = api.formatDateTime
      ? api.formatDateTime(now, {
        weekday: "long",
        day: "numeric",
        month: "long"
      })
      : now.toLocaleDateString(undefined, {
          weekday: "long",
          day: "numeric",
          month: "long"
        });

    const total = doses.length || 1;

    const taken = doses.filter(
      (dose) => dose.s === "taken"
    ).length;

    const missed = doses.filter(
      (dose) => dose.s === "missed"
    ).length;

    $("ring-n").textContent =
      taken + "/" + doses.length;

    $("ring-a11y").setAttribute(
      "aria-label",
      taken +
        " of " +
        doses.length +
        " doses taken, " +
        missed +
        " missed"
    );

    const takenArc = $("arc-taken");
    const missedArc = $("arc-missed");

    takenArc.style.strokeDasharray = C;
    missedArc.style.strokeDasharray = C;

    takenArc.style.strokeDashoffset =
      C * (1 - taken / total);

    missedArc.style.strokeDashoffset =
      C * (1 - missed / total);

    missedArc.style.transform =
      "rotate(" + (360 * taken / total) + "deg)";

    missedArc.style.transformOrigin = "60px 60px";

    takenArc.style.opacity = taken ? 1 : 0;
    missedArc.style.opacity = missed ? 1 : 0;

    // Next dose.
    const next = doses.find((dose) => !dose.s);
    const nextButton = $("next-btn");

    if (next) {
      const difference = at(next) - now;

      $("next-when").textContent =
        difference >= 0
          ? "in " + span(difference)
          : span(difference) + " overdue";

      $("next-when").style.color =
        difference < 0 ? "var(--bad)" : "";

      $("next-what").textContent =
        next.name +
        ", " +
        next.dose +
        " at " +
        hm(next);

      nextButton.hidden = false;

      nextButton.onclick = () =>
        setS(next.key, "taken");

    } else {
      $("next-when").textContent =
        doses.length ? "All done" : "No doses";

      $("next-when").style.color = "";

      $("next-what").textContent =
        doses.length
          ? "You've recorded every dose for today."
          : "Add a medication to see your schedule.";

      nextButton.hidden = true;
    }

    // Today's dose list.
    const list = $("list");

    list.innerHTML = "";

    doses.forEach((dose) => {
      const item = document.createElement("li");

      item.className = "dose";

      const late =
        !dose.s && at(dose) < now;

      item.innerHTML =
        '<time></time>' +
        '<div class="meta"><b></b><span></span></div>' +
        '<div class="act"></div>';

      item.querySelector("time").textContent =
        hm(dose);

      item.querySelector("b").textContent =
        dose.name;

      item.querySelector("span").textContent =
        dose.dose;

      const actions = item.querySelector(".act");

      if (dose.s) {
        const chip = document.createElement("span");

        chip.className = "chip " + dose.s;

        chip.textContent =
          dose.s === "taken" ? "Taken" : "Missed";

        actions.appendChild(chip);

      } else {
        if (late) {
          const label = document.createElement("span");

          label.className = "late";
          label.textContent = "Overdue";

          actions.appendChild(label);
        }

        [
          ["Taken", "ok", "taken"],
          ["Missed", "bad", "missed"]
        ].forEach((option) => {
          const button = document.createElement("button");

          button.className = "btn " + option[1];
          button.textContent = option[0];

          button.setAttribute(
            "aria-label",
            option[0] +
              ": " +
              dose.name +
              " at " +
              hm(dose)
          );

          button.disabled = pendingDoses.has(dose.key);

          button.onclick = () =>
            setS(dose.key, option[2]);

          actions.appendChild(button);
        });
      }

      list.appendChild(item);
    });

    renderHeat();
    renderHistory();
    renderReminders();
  }

  // =====================================================
  // 6. ADHERENCE CALENDAR
  // =====================================================

  function renderHeat() {
    const box = $("heat");

    box.innerHTML = "";

    const now = new Date();

    for (let i = 27; i >= 0; i--) {
      const day = dk(
        new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() - i
        )
      );

      const records = activity.filter(
        (item) => item.day === day
      );

      const cell = document.createElement("i");

      if (records.length) {
        const ratio =
          records.filter(
            (item) => item.s === "taken"
          ).length / records.length;

        cell.className =
          ratio < 0.5
            ? "x"
            : ratio < 0.67
              ? "l1"
              : ratio < 1
                ? "l2"
                : "l3";
      }

      cell.title = day;

      box.appendChild(cell);
    }
  }

  // =====================================================
  // 7. MEDICATION MANAGEMENT
  // =====================================================

  function renderMeds() {
    const list = $("med-list");

    list.innerHTML = "";

    $("meds-count").textContent =
      meds.length +
      (meds.length === 1
        ? " medication"
        : " medications");

    $("meds-empty").hidden = meds.length > 0;

    meds.forEach((med) => {
      const item = document.createElement("li");

      item.className = "med";

      item.innerHTML =
        '<div><div class="name"></div><div class="dose"></div></div>' +
        '<div class="times"></div>' +
        '<div class="off"></div>' +
        '<div class="row-actions">' +
        '<button class="btn" data-a="edit">Edit</button>' +
        '<button class="btn bad" data-a="del">Delete</button>' +
        "</div>";

      item.querySelector(".name").textContent =
        med.name;

      item.querySelector(".dose").textContent =
        med.dose;

      (med.times || []).forEach((time) => {
        const chip = document.createElement("span");

        chip.className = "chip";
        chip.textContent = time;

        item.querySelector(".times").appendChild(chip);
      });

      item.querySelector(".off").textContent =
        med.remind ? "Reminders on" : "Reminders off";

      const editButton = item.querySelector(
        "[data-a=edit]"
      );

      const deleteButton = item.querySelector(
        "[data-a=del]"
      );

      editButton.setAttribute(
        "aria-label",
        "Edit " + med.name
      );

      deleteButton.setAttribute(
        "aria-label",
        "Delete " + med.name
      );

      editButton.onclick = () =>
        openForm(med.id);

      deleteButton.onclick = () =>
        removeMed(med);

      list.appendChild(item);
    });
  }

  function printSheet() {
    document.body.classList.add("printing-meds");

    window.addEventListener(
      "afterprint",
      () => document.body.classList.remove("printing-meds"),
      { once: true }
    );

    window.print();
  }

  $("print-med-list").onclick = () => {
    const list = $("print-medications");
    const doses = buildDoses();
    const missed = doses.some((dose) => dose.s === "missed");
    const fullyRecorded =
      doses.length > 0 && doses.every((dose) => dose.s);

    $("print-title").textContent = "HealthMate medication list";
    $("print-note").textContent =
      "Keep this list current and follow the instructions from your healthcare professional.";
    $("print-adherence").textContent =
      "Today's missed-dose status: " +
      (missed
        ? "Yes"
        : doses.length === 0
          ? "No doses scheduled"
          : fullyRecorded
            ? "No"
            : "Not fully recorded");

    list.innerHTML = "";

    if (meds.length) {
      meds.forEach((med) => {
        const item = document.createElement("li");
        const name = document.createElement("strong");
        const dose = document.createElement("span");
        const times = document.createElement("span");
        const adherence = document.createElement("span");
        const takenTimes = document.createElement("span");
        const missedTimes = document.createElement("span");
        const reminders = document.createElement("span");
        const medicationDoses = doses.filter(
          (scheduledDose) => scheduledDose.medId === med.id
        );
        const medicationMissed = medicationDoses.some(
          (scheduledDose) => scheduledDose.s === "missed"
        );
        const medicationFullyRecorded =
          medicationDoses.length > 0 &&
          medicationDoses.every((scheduledDose) => scheduledDose.s);

        item.className = "print-medication";
        name.textContent = med.name;
        dose.textContent = med.dose || "Dose not specified";
        times.textContent =
          "Scheduled times: " +
          ((med.times || []).join(", ") || "No times set");
        adherence.textContent =
          "Missed today: " +
          (medicationMissed
            ? "Yes"
            : medicationDoses.length === 0
              ? "No doses scheduled"
              : medicationFullyRecorded
                ? "No"
                : "Not fully recorded");
        const takenDoses = medicationDoses.filter(
          (scheduledDose) => scheduledDose.s === "taken"
        );
        const missedDoses = medicationDoses.filter(
          (scheduledDose) => scheduledDose.s === "missed"
        );
        const formatDoseRecords = (records, field) =>
          records.length
            ? records
                .map((scheduledDose) => {
                  const recordedAt = dateTimeLabel(
                    scheduledDose[field]
                  );

                  return recordedAt
                    ? recordedAt +
                        " (scheduled time " +
                        scheduledDose.time +
                        ")"
                    : "date and time not recorded (scheduled " +
                        scheduledDose.time +
                        ")";
                })
                .join("; ")
            : "None today";

        takenTimes.textContent =
          "Taken: " + formatDoseRecords(takenDoses, "takenAt");
        missedTimes.textContent =
          "Missed: " + formatDoseRecords(missedDoses, "missedAt");
        reminders.textContent =
          "Reminders: " + (med.remind ? "On" : "Off");

        item.append(
          name,
          dose,
          times,
          adherence,
          takenTimes,
          missedTimes,
          reminders
        );
        list.appendChild(item);
      });
    } else {
      const empty = document.createElement("li");
      empty.textContent = "No medications saved.";
      list.appendChild(empty);
    }

    const preparedAt = new Date();
    $("print-date").textContent =
      "Prepared on " +
      (api.formatDateTime
        ? api.formatDateTime(preparedAt, {
        year: "numeric",
        month: "long",
        day: "numeric"
        })
        : preparedAt.toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric"
          }));

    printSheet();
  };

  async function removeMed(med) {
    if (
      !confirm(
        api.CONFIG.USE_MOCK
          ? "Delete " +
              med.name +
              "? It will stop generating reminders. Past history is kept."
          : "Remove " +
              med.name +
              " from your active schedule? Its schedules will be deactivated. The backend keeps the medication record and past history."
      )
    ) {
      return;
    }

    try {
      await api.deleteMed(med.id);

      meds = meds.filter(
        (item) => item.id !== med.id
      );

      renderMeds();
      render();

      toast(
        api.CONFIG.USE_MOCK
          ? med.name + " deleted."
          : med.name +
              " removed from your active schedule. Existing dose history is kept; the backend retains the medication record."
      );

    } catch (error) {
      toast(errMsg(error));
    }
  }

  // =====================================================
  // 8. MEDICATION FORM
  // =====================================================

  const dialog = $("med-dialog");

  function timeInputs(count, values) {
    const box = $("f-times");

    box.innerHTML = "";

    const defaults = DEFAULT_TIMES[count] || ["08:00"];

    for (let i = 0; i < count; i++) {
      const input = document.createElement("input");

      input.type = "time";

      input.value =
        (values && values[i]) || defaults[i] || "08:00";

      input.setAttribute(
        "aria-label",
        "Dose time " + (i + 1)
      );

      box.appendChild(input);
    }
  }

  function clearErrors() {
    ["name", "dose", "times", "form"].forEach(
      (key) => {
        $("e-" + key).textContent = "";
      }
    );

    ["f-name", "f-dose"].forEach((id) => {
      $(id).removeAttribute("aria-invalid");
    });
  }

  function openForm(id) {
    editId = id || null;

    clearErrors();

    const med = meds.find(
      (item) => item.id === id
    );

    $("dlg-title").textContent =
      med ? "Edit medication" : "Add medication";

    $("f-name").value =
      med ? med.name : "";

    $("f-dose").value =
      med ? med.dose : "";

    $("f-freq").value =
      med ? med.times.length : 1;

    $("f-remind").checked =
      med ? med.remind : true;

    timeInputs(
      med ? med.times.length : 1,
      med && med.times
    );

    dialog.showModal();

    $("f-name").focus();
  }

  $("add-med").onclick = () =>
    openForm();

  $("dlg-cancel").onclick = () =>
    dialog.close();

  $("f-freq").onchange = () => {
    const existing = Array.from(
      $("f-times").children
    ).map((input) => input.value);

    timeInputs(
      Number($("f-freq").value),
      existing
    );
  };

  $("med-form").onsubmit = async (event) => {
    event.preventDefault();

    clearErrors();

    const name = $("f-name").value.trim();
    const dose = $("f-dose").value.trim();

    const times = Array.from(
      $("f-times").children
    ).map((input) => input.value);

    let invalid = false;

    if (name.length < 2) {
      $("e-name").textContent =
        "Enter the medication name (at least 2 characters).";

      $("f-name").setAttribute(
        "aria-invalid",
        "true"
      );

      invalid = true;
    }

    if (!dose) {
      $("e-dose").textContent =
        "Enter the dose, for example 500 mg or 1 capsule.";

      $("f-dose").setAttribute(
        "aria-invalid",
        "true"
      );

      invalid = true;
    }

    if (times.some((time) => !time)) {
      $("e-times").textContent =
        "Set a time for every dose.";

      invalid = true;

    } else if (
      new Set(times).size !== times.length
    ) {
      $("e-times").textContent =
        "Each dose needs a different time.";

      invalid = true;
    }

    if (invalid) {
      const first = dialog.querySelector(
        '[aria-invalid="true"]'
      );

      if (first) first.focus();

      return;
    }

    times.sort();

    const payload = {
      name,
      dose,
      times,
      remind: $("f-remind").checked
    };

    const button = $("save-med");

    button.disabled = true;
    button.textContent = "Saving...";

    try {
      const saved = editId
        ? await api.updateMed(editId, payload)
        : await api.createMed(payload);

      if (editId) {
        meds = meds.map((item) =>
          item.id === editId ? saved : item
        );
      } else {
        meds.push(saved);
      }

      dialog.close();

      renderMeds();
      render();

      toast(
        name +
          (editId ? " updated." : " added.")
      );

    } catch (error) {
      const errors = error.errors || {};

      let displayed = false;

      [
        ["name", "name", "f-name"],
        ["dose", "dose", "f-dose"],
        ["times", "times", null]
      ].forEach((field) => {
        if (errors[field[0]]) {
          $("e-" + field[1]).textContent =
            errors[field[0]];

          if (field[2]) {
            $(field[2]).setAttribute(
              "aria-invalid",
              "true"
            );
          }

          displayed = true;
        }
      });

      if (!displayed) {
        $("e-form").textContent = errMsg(error);
      }

    } finally {
      button.disabled = false;
      button.textContent = "Save medication";
    }
  };

  // =====================================================
  // 9. HISTORY
  // =====================================================

  let historyStatus = "all";
  let historyMedication = "all";

  function historyRows() {
    return activity
      .map((item) => ({
        day: item.day,
        date: parseDay(item.day),
        time: item.time,
        name: item.name,
        dose: item.dose,
        s: item.s
      }))
      .sort((a, b) => {
        if (a.day === b.day) {
          return a.time < b.time ? 1 : -1;
        }

        return a.day < b.day ? 1 : -1;
      });
  }

  function dayLabel(record) {
    const today = new Date();

    const yesterday = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - 1
    );

    if (record.day === dk(today)) {
      return "Today";
    }

    if (record.day === dk(yesterday)) {
      return "Yesterday";
    }

    return record.date.toLocaleDateString(
      undefined,
      {
        weekday: "short",
        day: "numeric",
        month: "short"
      }
    );
  }

  function renderHistory() {
    const all = historyRows();
    const select = $("h-med");

    const names = Array.from(
      new Set(all.map((record) => record.name))
    ).sort();

    select.innerHTML =
      '<option value="all">All medications</option>';

    names.forEach((name) => {
      const option = document.createElement("option");

      option.value = name;
      option.textContent = name;

      select.appendChild(option);
    });

    if (!names.includes(historyMedication)) {
      historyMedication = "all";
    }

    select.value = historyMedication;

    const filtered = all.filter(
      (record) =>
        historyMedication === "all" ||
        record.name === historyMedication
    );

    const taken = filtered.filter(
      (record) => record.s === "taken"
    ).length;

    const missed = filtered.filter(
      (record) => record.s === "missed"
    ).length;

    const percentage =
      taken + missed
        ? Math.round(
            (taken / (taken + missed)) * 100
          )
        : 0;

    $("h-stats").innerHTML =
      '<div class="stat"><b>' +
      percentage +
      '%</b><span>Adherence</span></div>' +
      '<div class="stat ok"><b>' +
      taken +
      '</b><span>Taken</span></div>' +
      '<div class="stat bad"><b>' +
      missed +
      "</b><span>Missed</span></div>";

    const rows = filtered.filter(
      (record) =>
        historyStatus === "all" ||
        record.s === historyStatus
    );

    const box = $("h-list");

    box.innerHTML = "";

    $("h-empty").hidden = rows.length > 0;

    let currentDay = "";
    let list = null;

    rows.forEach((record) => {
      if (record.day !== currentDay) {
        currentDay = record.day;

        const heading = document.createElement("h3");

        heading.className = "day-h";
        heading.textContent = dayLabel(record);

        box.appendChild(heading);

        list = document.createElement("ul");

        box.appendChild(list);
      }

      const item = document.createElement("li");

      item.className = "h-item";

      item.innerHTML =
        '<time></time><div><b></b><span class="d"></span></div>' +
        '<span class="chip"></span>';

      item.querySelector("time").textContent =
        record.time;

      item.querySelector("b").textContent =
        record.name;

      item.querySelector(".d").textContent =
        record.dose;

      const chip = item.querySelector(".chip");

      chip.className = "chip " + record.s;

      chip.textContent =
        record.s === "taken" ? "Taken" : "Missed";

      list.appendChild(item);
    });
  }

  each(".seg", (button) => {
    button.onclick = () => {
      historyStatus = button.dataset.st;

      each(".seg", (item) => {
        item.setAttribute(
          "aria-pressed",
          item === button ? "true" : "false"
        );
      });

      renderHistory();
    };
  });

  $("h-med").onchange = () => {
    historyMedication = $("h-med").value;

    renderHistory();
  };

  const reportToday = new Date();
  const reportStart = new Date(reportToday);
  reportStart.setDate(reportToday.getDate() - 27);
  $("report-from").value = dk(reportStart);
  $("report-to").value = dk(reportToday);

  ["report-from", "report-to"].forEach((id) => {
    $(id).addEventListener("input", () => {
      $("report-to").setCustomValidity("");
    });
  });

  $("report-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    const from = $("report-from").value;
    const to = $("report-to").value;
    const toInput = $("report-to");

    toInput.setCustomValidity(
      from > to ? "The end date must be on or after the start date." : ""
    );

    if (!$("report-form").reportValidity()) return;

    const button = $("print-report");
    button.disabled = true;
    button.textContent = "Preparing report...";

    try {
      const records = await api.listActivity(from, to);
      const loggedRecords = records.filter(
        (record) => record.s === "taken" || record.s === "missed"
      );
      const taken = loggedRecords.filter(
        (record) => record.s === "taken"
      ).length;
      const missed = loggedRecords.filter(
        (record) => record.s === "missed"
      ).length;
      const total = taken + missed;
      const list = $("print-medications");

      list.innerHTML = "";
      $("print-title").textContent = "HealthMate adherence report";
      $("print-date").textContent =
        "Date range: " +
        parseDay(from).toLocaleDateString(undefined, {
          year: "numeric",
          month: "long",
          day: "numeric"
        }) +
        " to " +
        parseDay(to).toLocaleDateString(undefined, {
          year: "numeric",
          month: "long",
          day: "numeric"
        }) +
        " | Prepared " +
        dateTimeLabel(new Date().toISOString());
      $("print-adherence").textContent =
        "Taken: " +
        taken +
        " | Missed: " +
        missed +
        " | Logged: " +
        total +
        " | Adherence: " +
        (total ? Math.round((taken / total) * 100) + "%" : "No recorded doses");
      $("print-note").textContent =
        "This report includes recorded doses only. Scheduled times and the date and time each status was recorded are shown separately.";

      if (loggedRecords.length) {
        loggedRecords
          .slice()
          .sort((a, b) => {
            const aTime = a.takenAt || a.missedAt || a.day + "T" + a.time;
            const bTime = b.takenAt || b.missedAt || b.day + "T" + b.time;
            return aTime.localeCompare(bTime);
          })
          .forEach((record) => {
            const item = document.createElement("li");
            const name = document.createElement("strong");
            const dose = document.createElement("span");
            const scheduled = document.createElement("span");
            const status = document.createElement("span");
            const statusLabel =
              record.s === "taken" ? "Taken" : "Missed";
            const recordedAt = dateTimeLabel(
              record.s === "taken" ? record.takenAt : record.missedAt
            );

            item.className = "print-medication";
            name.textContent = record.name;
            dose.textContent = record.dose || "Dose not specified";
            const recordedDate = parseDay(record.day).toLocaleDateString(undefined, {
                year: "numeric",
                month: "long",
                day: "numeric"
              });
            scheduled.textContent =
              (record.scheduledTime
                ? "Scheduled time: " + record.scheduledTime
                : record.scheduledTimes &&
                    record.scheduledTimes.length > 1
                  ? "Scheduled times: " +
                    record.scheduledTimes.join(", ") +
                    " (the specific dose time is not included in this log)"
                  : "Scheduled time: " + record.time) +
              " | Recorded date: " +
              recordedDate;
            status.className = "print-status " + record.s;
            status.textContent =
              statusLabel +
              ": " +
              (recordedAt || "date and time not recorded");

            item.append(name, dose, scheduled, status);
            list.appendChild(item);
          });
      } else {
        const empty = document.createElement("li");
        empty.textContent =
          "No taken or missed doses were recorded in this date range.";
        list.appendChild(empty);
      }

      printSheet();
    } catch (error) {
      toast(errMsg(error));
    } finally {
      button.disabled = false;
      button.textContent = "Print report";
    }
  });

  // =====================================================
  // 10. REMINDERS AND NOTIFICATIONS
  // =====================================================

  const canNotify = () =>
    "Notification" in window;

  function notify(title, body, tag) {
    toast(title + ": " + body);

    if (
      canNotify() &&
      Notification.permission === "granted"
    ) {
      try {
        const notification = new Notification(
          title,
          {
            body,
            tag
          }
        );

        notification.onclick = () => {
          window.focus();
          notification.close();
        };

      } catch (error) {
        console.warn(
          "Browser notification could not be displayed.",
          error
        );
      }
    }
  }

  function checkReminders() {
    if (!user) return;

    const now = new Date();

    buildDoses().forEach((dose) => {
      if (!dose.remind || dose.s) return;

      const until = at(dose) - now;

      const id =
        dose.key + "@" + dk(now);

      if (
        until <= 0 &&
        until >= -REMINDER_GRACE_MS &&
        !fired.has(id)
      ) {
        fired.add(id);

        notify(
          "Medication due now",
          dose.name +
            ", " +
            dose.dose +
            " at " +
            hm(dose),
          dose.key
        );
      }
    });
  }

  function renderPerm() {
    let title;
    let description;
    let showButton = false;

    if (!canNotify()) {
      title = "Notifications aren't supported here";

      description =
        "You'll still see in-app alerts while HealthMate is open.";

    } else if (
      Notification.permission === "granted"
    ) {
      title = "Notifications are on";

      description =
        "You'll get an alert at each scheduled dose time while HealthMate is open in a browser tab.";

    } else if (
      Notification.permission === "denied"
    ) {
      title = "Notifications are blocked";

      description =
        "Allow notifications for this site in your browser settings, then reload. In-app alerts still work.";

    } else {
      title = "Turn on notifications";

      description =
        "Allow notifications to get an alert at each scheduled dose time.";

      showButton = true;
    }

    $("perm-title").textContent = title;
    $("perm-text").textContent = description;

    $("perm-btn").hidden = !showButton;
  }

  function renderReminders() {
    renderPerm();

    const list = $("rem-list");

    list.innerHTML = "";

    meds.forEach((med) => {
      const item = document.createElement("li");

      item.className = "r-item";

      item.innerHTML =
        '<div><b></b><span class="d"></span></div>' +
        '<button class="switch" role="switch"></button>';

      item.querySelector("b").textContent =
        med.name;

      item.querySelector(".d").textContent =
        med.times.join(", ");

      const toggle = item.querySelector(".switch");

      toggle.setAttribute(
        "aria-checked",
        med.remind ? "true" : "false"
      );

      toggle.setAttribute(
        "aria-label",
        "Reminders for " + med.name
      );

      toggle.onclick = async () => {
        const previous = med.remind;

        med.remind = !previous;

        toggle.disabled = true;

        renderReminders();
        renderMeds();

        try {
          const saved = await api.updateMed(
            med.id,
            {
              name: med.name,
              dose: med.dose,
              times: med.times,
              remind: med.remind
            }
          );

          Object.assign(med, saved);

          toast(
            "Reminders " +
              (med.remind ? "on" : "off") +
              " for " +
              med.name
          );

        } catch (error) {
          med.remind = previous;

          toast(errMsg(error));

        } finally {
          renderReminders();
          renderMeds();
        }
      };

      list.appendChild(item);
    });

    // Upcoming doses.
    const now = new Date();

    const nextList = $("rem-next");

    nextList.innerHTML = "";

    const upcoming = buildDoses()
      .filter(
        (dose) =>
          dose.remind &&
          !dose.s &&
          at(dose) >= now
      )
      .slice(0, 6);

    $("rem-empty").hidden =
      upcoming.length > 0;

    upcoming.forEach((dose) => {
      const item = document.createElement("li");

      item.className = "up";

      item.innerHTML =
        '<time></time><div><b></b></div><span class="in"></span>';

      item.querySelector("time").textContent =
        hm(dose);

      item.querySelector("b").textContent =
        dose.name;

      item.querySelector(".in").textContent =
        "in " + span(at(dose) - now);

      nextList.appendChild(item);
    });
  }

  $("find-hospital").onclick = () => {
    const button = $("find-hospital");
    const status = $("hospital-status");
    const mapLink = $("hospital-map-link");

    mapLink.hidden = true;

    if (!navigator.geolocation) {
      status.textContent =
        "Location services aren't available in this browser.";
      return;
    }

    button.disabled = true;
    status.textContent = "Getting your location...";

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const query =
          "hospitals near " +
          position.coords.latitude +
          "," +
          position.coords.longitude;
        const mapsUrl = new URL(
          "https://www.google.com/maps/search/"
        );

        mapsUrl.searchParams.set("api", "1");
        mapsUrl.searchParams.set("query", query);

        mapLink.href = mapsUrl.toString();
        mapLink.hidden = false;
        status.textContent =
          "Location ready. Open Google Maps to view nearby hospitals.";
        button.disabled = false;
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          status.textContent =
            "Location access was denied. Allow location access in your browser settings, then try again.";
        } else if (error.code === error.POSITION_UNAVAILABLE) {
          status.textContent =
            "Your location couldn't be determined. Check that location services are available and try again.";
        } else if (error.code === error.TIMEOUT) {
          status.textContent =
            "The location request timed out. Please try again.";
        } else {
          status.textContent =
            "Couldn't get your location. Please try again.";
        }

        button.disabled = false;
      },
      {
        enableHighAccuracy: false,
        maximumAge: 60000,
        timeout: 10000
      }
    );
  };

  $("perm-btn").onclick = async () => {
    if (!canNotify()) {
      toast("Notifications are not supported in this browser.");
      return;
    }

    try {
      await Notification.requestPermission();

      renderPerm();

      if (Notification.permission === "granted") {
        toast("Notifications enabled.");
      }

    } catch (error) {
      renderPerm();

      toast(
        "Could not enable browser notifications. In-app reminders are still available."
      );
    }
  };

  $("test-btn").onclick = () => {
    notify(
      "HealthMate test",
      "Your reminder system is working.",
      "test"
    );
  };

  // =====================================================
  // 11. AUTHENTICATION
  // =====================================================

  const loginForm = $("login-form");
  const regForm = $("reg-form");

  const demoHint = $("demo-hint");

  if (demoHint && api.CONFIG) {
    demoHint.hidden = !api.CONFIG.USE_MOCK;
  }

  function authError(id, message) {
    const errorElement = $("e-" + id);

    if (errorElement) {
      errorElement.textContent = message || "";
    }

    const input = $(id);

    if (input) {
      if (message) {
        input.setAttribute("aria-invalid", "true");
      } else {
        input.removeAttribute("aria-invalid");
      }
    }
  }

  function firstInvalid(form) {
    const input = form.querySelector(
      '[aria-invalid="true"]'
    );

    if (input) {
      input.focus();
      return true;
    }

    return false;
  }

  function busy(form, loading, label) {
    const button = form.querySelector(
      'button[type="submit"]'
    );

    if (loading) {
      button.dataset.label = button.textContent;
      button.textContent = label;
    } else if (button.dataset.label) {
      button.textContent = button.dataset.label;
    }

    button.disabled = loading;
  }

  function authMode(mode) {
    const registering = mode === "register";

    loginForm.hidden = registering;
    regForm.hidden = !registering;

    $("auth-title").textContent =
      registering ? "CREATE ACCOUNT" : "SIGN IN";

    $("auth-sub").textContent =
      registering
        ? "Create an account with email address"
        : "Sign in with email address";

    (
      registering
        ? $("r-name")
        : $("l-email")
    ).focus();
  }

  each("[data-auth]", (button) => {
    button.onclick = () =>
      authMode(button.dataset.auth);
  });

  each(".pw-toggle", (button) => {
    button.onclick = () => {
      const input = $(button.dataset.for);

      const showing = input.type === "text";

      input.type = showing ? "password" : "text";

      button.textContent =
        showing ? "Show" : "Hide";

      button.setAttribute(
        "aria-label",
        showing ? "Show password" : "Hide password"
      );

      button.setAttribute(
        "aria-pressed",
        String(!showing)
      );
    };
  });

  async function enter(account) {
    user = account;

    try {
      await loadAll();

      document.body.classList.add("authed");

      show("home");

      renderMeds();
      render();
      document.documentElement.classList.remove(
        "session-checking"
      );

      window.scrollTo(0, 0);

      checkReminders();

    } catch (error) {
      user = null;

      await api.logout();

      throw error;
    }
  }

  function signOut(message) {
    user = null;

    meds = [];
    activity = [];

    pendingDoses.clear();
    fired.clear();

    api.logout();

    document.documentElement.classList.remove(
      "session-checking"
    );

    document.body.classList.remove("authed");

    loginForm.reset();
    regForm.reset();

    authMode("login");

    $("login-err").textContent =
      message || "";

    show("home");

    renderMeds();

    $("list").innerHTML = "";
    $("heat").innerHTML = "";
  }

  each("[data-logout]", (button) => {
    button.onclick = () => signOut();
  });

  api.setUnauthorizedHandler(() => {
    if (user) {
      signOut(
        "Your session expired. Please log in again."
      );
    }
  });

  $("clear-demo-data").onclick = async () => {
    if (
      !confirm(
        "Clear all demo accounts, medication schedules, and activity stored in this browser? You'll be signed out."
      )
    ) {
      return;
    }

    const button = $("clear-demo-data");

    button.disabled = true;

    try {
      await api.clearLocalData();

      signOut();

      toast("Demo data cleared.");

    } catch (error) {
      toast(errMsg(error));

    } finally {
      button.disabled = false;
    }
  };

  // =====================================================
  // 12. GOOGLE AUTHENTICATION
  // =====================================================

  function loadGoogleIdentity() {
    if (
      window.google &&
      window.google.accounts
    ) {
      return Promise.resolve(window.google);
    }

    return new Promise((resolve, reject) => {
      const existing = document.querySelector(
        'script[data-healthmate-google]'
      );

      if (existing) {
        existing.addEventListener(
          "load",
          () => resolve(window.google),
          { once: true }
        );

        existing.addEventListener(
          "error",
          () =>
            reject(
              new Error(
                "Could not load Google sign-in."
              )
            ),
          { once: true }
        );

        return;
      }

      const script = document.createElement("script");

      script.src =
        "https://accounts.google.com/gsi/client";

      script.async = true;
      script.defer = true;

      script.dataset.healthmateGoogle = "true";

      script.onload = () => {
        if (
          window.google &&
          window.google.accounts
        ) {
          resolve(window.google);
        } else {
          reject(
            new Error(
              "Google sign-in did not initialize."
            )
          );
        }
      };

      script.onerror = () =>
        reject(
          new Error(
            "Could not load Google sign-in."
          )
        );

      document.head.appendChild(script);
    });
  }

  $("google-login").onclick = async () => {
    const button = $("google-login");

    $("login-err").textContent = "";

    button.disabled = true;

    try {
      if (api.CONFIG.USE_MOCK) {
        await enter(await api.googleLogin());
        return;
      }

      if (!api.CONFIG.GOOGLE_CLIENT_ID) {
        throw new Error(
          "Google sign-in needs a Google OAuth client ID."
        );
      }

      const google = await loadGoogleIdentity();

      const credential = await new Promise(
        (resolve, reject) => {
          let settled = false;

          const finish = (callback, value) => {
            if (settled) return;

            settled = true;
            callback(value);
          };

          google.accounts.id.initialize({
            client_id: api.CONFIG.GOOGLE_CLIENT_ID,

            callback: (response) => {
              if (response.credential) {
                finish(resolve, response.credential);
              } else {
                finish(
                  reject,
                  new Error(
                    "Google sign-in was cancelled."
                  )
                );
              }
            },

            cancel_on_tap_outside: true
          });

          google.accounts.id.prompt((notification) => {
            if (
              notification.isNotDisplayed() ||
              notification.isSkippedMoment()
            ) {
              finish(
                reject,
                new Error(
                  "Google sign-in could not open. Check your browser settings and try again."
                )
              );
            }
          });
        }
      );

      await enter(
        await api.googleLogin({ credential })
      );

    } catch (error) {
      $("login-err").textContent =
        errMsg(error);

    } finally {
      button.disabled = false;
    }
  };

  // =====================================================
  // 13. FACEBOOK AUTHENTICATION
  // =====================================================

  let facebookSdkPromise = null;

  function loadFacebookSdk() {
    if (window.FB) {
      return Promise.resolve(window.FB);
    }

    if (facebookSdkPromise) {
      return facebookSdkPromise;
    }

    facebookSdkPromise = new Promise(
      (resolve, reject) => {
        window.fbAsyncInit = () => {
          try {
            window.FB.init({
              appId: api.CONFIG.FACEBOOK_APP_ID,
              cookie: true,
              xfbml: false,
              version: "v20.0"
            });

            resolve(window.FB);

          } catch (error) {
            reject(error);
          }
        };

        const script = document.createElement("script");

        script.id = "facebook-jssdk";

        script.src =
          "https://connect.facebook.net/en_US/sdk.js";

        script.async = true;
        script.defer = true;

        script.onerror = () => {
          facebookSdkPromise = null;

          reject(
            new Error(
              "Could not load Facebook sign-in."
            )
          );
        };

        document.head.appendChild(script);
      }
    );

    return facebookSdkPromise;
  }

  $("facebook-login").onclick = async () => {
    const button = $("facebook-login");

    $("login-err").textContent = "";

    button.disabled = true;

    try {
      if (api.CONFIG.USE_MOCK) {
        await enter(await api.facebookLogin());
        return;
      }

      if (!api.CONFIG.FACEBOOK_APP_ID) {
        throw new Error(
          "Facebook sign-in needs a Facebook app ID."
        );
      }

      const FB = await loadFacebookSdk();

      const accessToken = await new Promise(
        (resolve, reject) => {
          FB.login(
            (response) => {
              if (
                response.authResponse &&
                response.authResponse.accessToken
              ) {
                resolve(
                  response.authResponse.accessToken
                );
              } else {
                reject(
                  new Error(
                    "Facebook sign-in was cancelled."
                  )
                );
              }
            },
            {
              scope: "email,public_profile"
            }
          );
        }
      );

      await enter(
        await api.facebookLogin({ accessToken })
      );

    } catch (error) {
      $("login-err").textContent =
        errMsg(error);

    } finally {
      button.disabled = false;
    }
  };

  // =====================================================
  // 14. EMAIL LOGIN
  // =====================================================

  const EMAIL =
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  loginForm.onsubmit = async (event) => {
    event.preventDefault();

    const email = $("l-email").value
      .trim()
      .toLowerCase();

    const password = $("l-pass").value;

    authError(
      "l-email",
      !email
        ? "Enter your email."
        : !EMAIL.test(email)
          ? "Enter a valid email address."
          : ""
    );

    authError(
      "l-pass",
      password ? "" : "Enter your password."
    );

    $("login-err").textContent = "";

    if (firstInvalid(loginForm)) return;

    busy(loginForm, true, "Logging in...");

    try {
      await enter(
        await api.login({
          email,
          password
        })
      );

    } catch (error) {
      const errors = error.errors || {};

      if (errors.email) {
        authError("l-email", errors.email);
      }

      if (errors.password) {
        authError("l-pass", errors.password);
      }

      $("login-err").textContent =
        errMsg(error);

    } finally {
      busy(loginForm, false);
    }
  };

  // =====================================================
  // 15. REGISTRATION
  // =====================================================

  regForm.onsubmit = async (event) => {
    event.preventDefault();

    const fullName = $("r-name").value.trim();

    const email = $("r-email").value
      .trim()
      .toLowerCase();

    const password = $("r-pass").value;
    const confirmPassword = $("r-pass2").value;

    authError(
      "r-name",
      fullName.length < 2
        ? "Enter your full name."
        : ""
    );

    authError(
      "r-email",
      !EMAIL.test(email)
        ? "Enter a valid email address."
        : ""
    );

    authError(
      "r-pass",
      password.length < 8 ||
      !/[A-Za-z]/.test(password) ||
      !/\d/.test(password)
        ? "Use at least 8 characters with a letter and a number."
        : ""
    );

    authError(
      "r-pass2",
      confirmPassword !== password
        ? "Passwords do not match."
        : ""
    );

    if (firstInvalid(regForm)) return;

    busy(
      regForm,
      true,
      "Creating account..."
    );

    try {
      await enter(
        await api.register({
          fullName,
          email,
          password
        })
      );

    } catch (error) {
      const errors = error.errors || {};

      let displayed = false;

      [
        ["fullName", "r-name"],
        ["name", "r-name"],
        ["email", "r-email"],
        ["password", "r-pass"]
      ].forEach(([field, input]) => {
        if (errors[field]) {
          authError(input, errors[field]);
          displayed = true;
        }
      });

      if (!displayed) {
        $("login-err").textContent =
          errMsg(error);
      }

      firstInvalid(regForm);

    } finally {
      busy(regForm, false);
    }
  };

  // =====================================================
  // 16. NAVIGATION
  // =====================================================

  function show(view) {
    each("[data-view]", (element) => {
      element.hidden =
        element.dataset.view !== view;
    });

    each("[data-nav]", (button) => {
      if (button.dataset.nav === view) {
        button.setAttribute(
          "aria-current",
          "page"
        );
      } else {
        button.removeAttribute("aria-current");
      }
    });

    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });
  }

  each("[data-nav]", (button) => {
    button.onclick = () => {
      show(button.dataset.nav);
    };
  });

  // =====================================================
  // 17. THEME MANAGEMENT
  // =====================================================

  const isDark = () => {
    const theme =
      document.documentElement.getAttribute(
        "data-theme"
      );

    return theme
      ? theme === "dark"
      : window.matchMedia(
          "(prefers-color-scheme: dark)"
        ).matches;
  };

  try {
    const savedTheme =
      localStorage.getItem("hm-theme");

    if (savedTheme === "dark" || savedTheme === "light") {
      document.documentElement.setAttribute(
        "data-theme",
        savedTheme
      );
    }
  } catch (error) {
    console.warn("Theme preference could not be loaded.");
  }

  each("[data-theme-toggle]", (button) => {
    button.onclick = () => {
      const next = isDark() ? "light" : "dark";

      document.documentElement.setAttribute(
        "data-theme",
        next
      );

      try {
        localStorage.setItem("hm-theme", next);
      } catch (error) {
        console.warn(
          "Theme preference could not be saved."
        );
      }
    };
  });

  // =====================================================
  // 18. APPLICATION STARTUP
  // =====================================================

  show("home");

  renderMeds();

  // Refresh the dashboard periodically.
  setInterval(() => {
    if (user) {
      render();
    }
  }, 30000);

  // Check medication reminders.
  setInterval(checkReminders, 5000);

  document.addEventListener(
    "visibilitychange",
    () => {
      if (!document.hidden) {
        checkReminders();
      }
    }
  );

  window.addEventListener(
    "focus",
    checkReminders
  );

  // Restore an existing session.
  if (api.hasSession()) {
    api.me()
      .then(enter)
      .catch(() => {
        api.logout();
        signOut();
      });
  }

})();