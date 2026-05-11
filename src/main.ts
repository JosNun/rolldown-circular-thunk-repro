// Main entry: lazy-loads trigger-error and (separately) trigger-wrapping.
// In production the user lands on one route or the other; never both.
const out = document.getElementById("out")!;

if (location.search.includes("wrapping")) {
  import("./trigger-wrapping").then(() => {
    out.textContent = "loaded wrapping route";
  });
} else {
  import("./trigger-error").then((m) => {
    try {
      out.textContent = `OK: ${m.check()}`;
    } catch (e) {
      out.textContent = "CRASH: " + (e as Error).message;
    }
  });
}
