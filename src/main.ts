const out = document.getElementById("out")!;
import("./dashboard").then((m) => {
  try {
    out.textContent = `OK: ${m.default()}`;
  } catch (e) {
    out.textContent = "CRASH: " + (e as Error).message;
  }
});
