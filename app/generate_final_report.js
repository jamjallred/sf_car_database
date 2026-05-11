window.addEventListener("DOMContentLoaded", () => {
  const dibsInput = document.getElementById("dibsInput");
  const dibsFileName = document.getElementById("dibsFileName");
  const dibsSelectBtn = document.getElementById("dibsSelectBtn");

  const finalInput = document.getElementById("finalInput");
  const finalFileName = document.getElementById("finalFileName");
  const finalSelectBtn = document.getElementById("finalSelectBtn");

  const generateBtn = document.getElementById("generateBtn");

  dibsSelectBtn.addEventListener("click", () => dibsInput.click());
  finalSelectBtn.addEventListener("click", () => finalInput.click());

  dibsInput.addEventListener("change", () => {
    const dibsFile = dibsInput.files[0];
    dibsFileName.value = dibsFile ? dibsFile.name : "No file selected";
  });
  finalInput.addEventListener("change", () => {
    const finalFile = finalInput.files[0];
    finalFileName.value = finalFile ? finalFile.name : "No file selected";
  })

  generateBtn.addEventListener("click", async () => {
    const dibsFile = dibsInput.files[0];
    const finalFile = finalInput.files[0];

    if (!dibsFile) {
      alert("Please select a dibs file first (.xlsx)");
      return;
    }

    if (!finalFile) {
      alert("Please select an initial results first (.csv)");
      return;
    }

    if (!finalFile.name.toLowerCase().endsWith(".csv")) {
      alert("Please ensure the initial results file is a .csv file");
      return;
    }

    if (!dibsFile.name.toLowerCase().endsWith(".xlsx")) {
      alert("Please ensure the dibs file is an .xlsx file");
      return;
    }

    const formData = new FormData();
    formData.append("dibs", dibsFile);
    formData.append("initial", finalFile);

    const resp = await fetch("/api/generate_final_report", {
      method: "POST",
      body: formData,
    });

    if (!resp.ok) {
      alert("Request failed");
      return;
    }

    const disposition = resp.headers.get("Content-Disposition");
    let filename = "grounded.xlsx";

    console.log(resp.headers.get("Content_Disposition"))

    if (disposition) {
      const match = disposition.match(/filename="([^"]+)"/);
      if (match) {
        filename = match[1];
      }
    }


    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();

    URL.revokeObjectURL(url);

  });
});