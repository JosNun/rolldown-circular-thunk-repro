// Simulate what Rolldown emits: a wrapped d3-scale unit, where the wrapper
// is never called.
const o = (e, t) => () => (e && (t = e(e=0)), t);

// d3-scale continuous.js (simplified):
let zi;
const Bi = o(() => { zi = [0, 1]; });   // unit = [0, 1] — deferred behind Bi

function transformer() {
  let domain = zi, range = zi;            // reads undefined zi
  function rescale() {
    return Math.min(domain.length, range.length);  // CRASH
  }
  return function init(t, u) { return rescale(); };
}

function continuous() { return transformer()(x => x, x => x); }
function linear() { return continuous(); }

// React would call this:
console.log('Calling scaleLinear()...');
try {
  const scale = linear();
  console.log('OK, scale:', scale);
} catch (e) {
  console.log('CRASH:', e.message);
}
