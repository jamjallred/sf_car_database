window.addEventListener("DOMContentLoaded", () => {
  const dibsInput = document.getElementById("dibsInput");
  const dibsFileName = document.getElementById("dibsFileName");
  const dibsSelectBtn = document.getElementById("dibsSelectBtn");

  const generateBtn = document.getElementById("generateBtn");

  dibsSelectBtn.addEventListener("click", () => dibsInput.click());

  dibsInput.addEventListener("change", () => {
    const dibsFile = dibsInput.files[0];
    dibsFileName.value = dibsFile ? dibsFile.name : "No file selected";
  });

  generateBtn.addEventListener("click", async () => {
    const dibsFile = dibsInput.files[0];

    if (!dibsFile) {
      alert("Please select a file first (.xlsx)");
      return;
    }

    if (!dibsFile.name.toLowerCase().endsWith(".xlsx")) {
      alert("Please ensure the file is an .xlsx file");
      return;
    }

    const formData = new FormData();
    formData.append("dibs", dibsFile);

    const resp = await fetch("/api/generate_in_service", {
      method: "POST",
      body: formData,
    });

    if (!resp.ok) {
      alert("Request failed");
      return;
    }

    const disposition = resp.headers.get("Content-Disposition");
    let filename = "in-service.xlsx";

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