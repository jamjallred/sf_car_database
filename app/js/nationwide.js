// Nationwide page: after generating, offer to save that same sheet to the DB.
document.addEventListener("DOMContentLoaded", () => {
  const genForm = document.getElementById("generate-form");
  const saveForm = document.getElementById("save-form");
  const saveBtn = saveForm.querySelector('button[type="submit"]');
  const saveInput = saveForm.querySelector('input[type="file"]');
  const source = document.getElementById("save-source");
  const status = saveForm.querySelector(".status");

  let generated = null; // { blob, filename }

  function refresh() {
    const picked = saveInput.files[0];
    if (picked) {
      source.textContent = `Will save ${picked.name}`;
    } else if (generated) {
      source.textContent = `Will save ${generated.filename}`;
    } else {
      source.textContent = "";
    }
    saveBtn.disabled = !picked && !generated;
  }

  genForm.addEventListener("sf:generated", (e) => {
    generated = { blob: e.detail.blob, filename: e.detail.filename };
    SF.setStatus(status, "", "");
    refresh();
  });
  saveForm.addEventListener("sf:file", refresh);

  saveForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const picked = saveInput.files[0];
    const file = picked || (generated && new File([generated.blob], generated.filename));
    if (!file) return;

    const body = new FormData();
    body.append("file", file);

    SF.setBusy(saveBtn, true, "Saving…");
    SF.setStatus(status, "info", "Saving cars to the database…");
    try {
      const res = await SF.fetchJSON("/api/saveToDB", { method: "POST", body });
      const parts = [`${res.inserted} new`, `${res.updated} updated`];
      if (res.skipped) parts.push(`${res.skipped} skipped`);
      SF.setStatus(status, res.skipped ? "warn" : "ok", `Saved: ${parts.join(", ")}.`);
    } catch (err) {
      SF.setStatus(status, "err", err.message);
    } finally {
      SF.setBusy(saveBtn, false);
      refresh();
    }
  });

  refresh();
});
