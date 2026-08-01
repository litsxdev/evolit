const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function style(open, value) {
  return enabled ? `\u001B[${open}m${value}\u001B[0m` : String(value);
}

export const terminal = {
  bold(value) {
    return style("1", value);
  },
  dim(value) {
    return style("2", value);
  },
  red(value) {
    return style("31", value);
  },
  green(value) {
    return style("32", value);
  },
  yellow(value) {
    return style("33", value);
  },
  blue(value) {
    return style("34", value);
  },
  magenta(value) {
    return style("35", value);
  },
  cyan(value) {
    return style("36", value);
  },
};
