const out = document.getElementById("out")!;
const params = location.search;

if (params.includes("wrapping")) {
  import("./trigger-wrapping").then(() => {
    out.textContent = "loaded wrapping route";
  });
} else if (params.includes("other")) {
  import("./trigger-other").then((m) => {
    out.textContent = `OK: ${m.checkOther()}`;
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
