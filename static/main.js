async function loadResults() {
  const tbody = document.getElementById("results-body");
  tbody.innerHTML = "<tr><td colspan='2'>Loading...</td></tr>";

  try {
    const resp = await fetch("/api/results");
    if (!resp.ok) {
      throw new Error("HTTP " + resp.status);
    }

    const data = await resp.json(); // [{id: 1, name: "Alice"}, ...]

    tbody.innerHTML = "";

    if (data.length === 0) {
      tbody.innerHTML = "<tr><td colspan='2'>No results</td></tr>";
      return;
    }

    for (const row of data) {
      const tr = document.createElement("tr");

      const tdId = document.createElement("td");
      tdId.textContent = row.id;

      const tdName = document.createElement("td");
      tdName.textContent = row.name;

      tr.appendChild(tdId);
      tr.appendChild(tdName);
      tbody.appendChild(tr);
    }
  } catch (err) {
    console.error(err);
    tbody.innerHTML = "<tr><td colspan='2'>Error loading data</td></tr>";
  }
}

document.addEventListener("DOMContentLoaded", loadResults);