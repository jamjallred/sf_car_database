window.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("fileInput");
  const fileName = document.getElementById("fileName");
  const selectBtn = document.getElementById("selectBtn");
  const generateBtn = document.getElementById("generateBtn");

  selectBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    fileName.value = file ? file.name : "No file selected";
  });

  generateBtn.addEventListener("click", async () => {
    const file = fileInput.files[0];

    if (!file) {
      alert("Please select a file first.");
      return;
    }

    if (!file.name.toLowerCase().endsWith(".csv")) {
      alert("Please select a .csv file.");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    const resp = await fetch("/api/generate_grounded", {
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