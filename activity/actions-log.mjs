function message(strings, values) {
  return strings.reduce((text, part, index) => (
    text + part + (index < values.length ? String(values[index]) : "")
  ), "");
}

function commandMacro(command) {
  return (strings, ...values) => {
    const text = message(strings, values)
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    console.log(`::${command}::${text}`);
  };
}

export const actionsLog = {
  info(strings, ...values) {
    const text = message(strings, values);
    if (globalThis.core?.info) globalThis.core.info(text);
    else console.log(text);
  },
  debug(strings, ...values) {
    const text = message(strings, values);
    if (globalThis.core?.debug) globalThis.core.debug(text);
    else commandMacro("debug")(strings, ...values);
  },
  notice(strings, ...values) {
    const text = message(strings, values);
    if (globalThis.core?.notice) globalThis.core.notice(text);
    else commandMacro("notice")(strings, ...values);
  },
  warning(strings, ...values) {
    const text = message(strings, values);
    if (globalThis.core?.warning) globalThis.core.warning(text);
    else commandMacro("warning")(strings, ...values);
  },
  error(strings, ...values) {
    const text = message(strings, values);
    if (globalThis.core?.error) globalThis.core.error(text);
    else commandMacro("error")(strings, ...values);
  },
  group(strings, ...values) {
    const text = message(strings, values);
    if (globalThis.core?.startGroup) globalThis.core.startGroup(text);
    else commandMacro("group")(strings, ...values);
  },
  endGroup() {
    if (globalThis.core?.endGroup) globalThis.core.endGroup();
    else console.log("::endgroup::");
  },
};
