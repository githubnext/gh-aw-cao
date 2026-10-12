import * as ui from '@clack/prompts';
import { createInterface } from 'node:readline/promises';

export class SetupCancelled extends Error {}

export function createTerminalPrompt({ input, output, UsageError }) {
  if (!input.isTTY || !output.isTTY) {
    throw new UsageError('cao setup requires an interactive terminal. Run ./cao.sh setup from a terminal; use ./cao.sh setup-auth for scripted authentication.');
  }
  const options = { input, output };
  const answer = async (pending) => {
    const value = await pending;
    if (ui.isCancel(value)) throw new SetupCancelled();
    return value;
  };
  if (process.env.TERM !== 'dumb') {
    return {
      start: () => ui.intro('Set up Central Agentic Ops', options),
      step: (message) => ui.log.step(message, options),
      note: (message, title) => ui.note(message, title, options),
      text: (message, defaultValue = '', validate) => answer(ui.text({
        ...options, message, placeholder: defaultValue, defaultValue,
        validate: validate && ((value) => validate((value || defaultValue).trim())),
      })).then((value) => value.trim()),
      select: (message, choices) => answer(ui.select({
        ...options, message, options: choices, initialValue: choices[0]?.value,
      })),
      confirm: (message) => answer(ui.confirm({ ...options, message, initialValue: false })),
      cancel: (message) => ui.cancel(message, options),
      finish: () => ui.outro('Configuration saved. No campaigns installed or run.', options),
      failure: () => ui.cancel('Setup stopped. See the recovery guidance below.', options),
      close() {},
    };
  }

  const terminal = createInterface(options);
  const controller = new AbortController();
  terminal.on('SIGINT', () => controller.abort(new SetupCancelled()));
  const question = async (message) => {
    try {
      return await terminal.question(message, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    }
  };
  const note = (message, title) => output.write(`${title ? `${title}\n` : ''}${message}\n`);
  const text = async (message, defaultValue = '', validate) => {
    while (true) {
      const suffix = defaultValue ? ` [${defaultValue}]` : '';
      const value = (await question(`${message}${suffix}: `)).trim() || defaultValue;
      const error = validate?.(value);
      if (!error) return value;
      note(error);
    }
  };
  return {
    start: () => note('Set up Central Agentic Ops'),
    step: note,
    note,
    text,
    async select(message, choices) {
      note(message);
      choices.forEach((choice, index) => note(`  ${index + 1}. ${choice.label}${choice.hint ? ` (${choice.hint})` : ''}`));
      while (true) {
        const value = await text('Choose', '1');
        const index = /^\d+$/.test(value) ? Number(value) - 1 : -1;
        if (choices[index]) return choices[index].value;
        note(`Enter a number from 1 to ${choices.length}.`);
      }
    },
    async confirm(message) {
      const value = (await question(`${message} [y/N]: `)).trim().toLowerCase();
      return value === 'y' || value === 'yes';
    },
    cancel: note,
    finish: () => note('Configuration saved. No campaigns installed or run.'),
    failure: () => note('Setup stopped. See the recovery guidance below.'),
    close: () => terminal.close(),
  };
}
