import { scaleLinear } from "d3-scale";

export default function compute(): number {
  return scaleLinear().domain([0, 100]).range([0, 1])(50);
}
