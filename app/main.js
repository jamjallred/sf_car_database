window.addEventListener('DOMContentLoaded', () => {
  const savedUsername = localStorage.getItem('username');

  if (savedUsername) {
    document.getElementById('username').value = savedUsername;
  }

  updateProfileDisplay();

  document.getElementById("load-btn").addEventListener("click", loadResults);
});

function saveProfile() {
  const username = document.getElementById('username').value;

  if (username) {
    localStorage.setItem('username', username);
  }

  updateProfileDisplay();
}

function updateProfileDisplay() {
  const username = localStorage.getItem('username');
  const display = document.getElementById('current-profile');

  console.log('Username from storage:', username);
  console.log('Display element:', display);
  console.log('Setting text to:', username ? `Logged in as: ${username}` : 'No profile selected');

  if (username) {
    display.textContent = `Logged in as: ${username}`;
  } else {
    display.textContent = 'No profile selected';
  }
}

async function loadResults() {
  const input = document.getElementById("pk-input")
  const pkList = input.value;

  const table = document.getElementById("results-table");
  const thead = table.querySelector("thead");
  const tbody = document.getElementById("results-body");

  tbody.innerHTML = "<tr><td colspan='2'>Loading...</td></tr>";

  try {
    const resp = await fetch("/api/displaytestdata?ids=" + encodeURIComponent(pkList));
    if (!resp.ok) {
      throw new Error("HTTP " + resp.status);
    }

    const data = await resp.json(); // [{id: 1, name: "Alice"}, ...]
    console.log(data)

    thead.innerHTML = "";
    tbody.innerHTML = "";

    if (data.length === 0) {
      tbody.innerHTML = "<tr><td colspan='2'>No results</td></tr>";
      return;
    }

    // Create column header
    const columns = Object.keys(data[0])
    const headerRow = document.createElement("tr")

    for (const col of columns) {
      const th = document.createElement("th");
      th.textContent = col.charAt(0).toUpperCase() + col.slice(1); // Capitalize
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);

    // Populate table rows
    for (const row of data) {
      const tr = document.createElement("tr");

      for (const col of columns) {
        const td = document.createElement("td");
        td.textContent = row[col] ?? ''; // value might be missing
        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }


    // Initialize or reinitialize DataTables
    if ($.fn.DataTable.isDataTable('#results-table')) {
      $('#results-table').DataTable().destroy(); // Destroy old instance
    }
    $('#results-table').DataTable({
      pageLength: 25, // Show 25 rows per page
      order: [[0, 'asc']] // Default sort by first column (ID)
    })

  } catch (err) {
    console.error(err);
    tbody.innerHTML = "<tr><td>Error loading data</td></tr>";
  }
}