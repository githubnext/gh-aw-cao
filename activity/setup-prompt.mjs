import * as ui from '@clack/prompts';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

export class SetupCancelled extends Error {}

function styledPromptsEnabled({ input, output, environment = process.env }) {
  const capability = spawnSync('tput', ['colors'], {
    encoding: 'utf8',
    env: environment,
    timeout: 1000,
  });
  const colorCount = capability.status === 0 ? Number.parseInt(capability.stdout.trim(), 10) : 0;
  return Boolean(
    input?.isTTY
    && output?.isTTY
    && Number.isInteger(colorCount)
    && colorCount >= 8
    && !environment.NO_COLOR
    && !environment.ACCESSIBLE
    && !environment.CI
  );
}

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
  if (styledPromptsEnabled({ input, output })) {
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

export function createQuickstartProgress({
  input = process.stdin,
  output = process.stderr,
  environment = process.env,
} = {}) {
  const options = { input, output };
  if (styledPromptsEnabled({ input, output, environment })) {
    let active;
    const clear = () => {
      active?.clear();
      active = undefined;
    };
    return {
      start: () => ui.intro('Complete the CAO quickstart', options),
      step(message) {
        clear();
        active = ui.spinner(options);
        active.start(message);
      },
      success(message) {
        if (active) active.stop(message);
        else ui.log.success(message, options);
        active = undefined;
      },
      warning(message) {
        clear();
        ui.log.warn(message, options);
      },
      failure() {
        if (active) active.error('Quickstart stopped');
        else ui.cancel('Quickstart stopped', options);
        active = undefined;
      },
      finish(message) {
        clear();
        ui.outro(message, options);
      },
    };
  }
  const write = (message) => output.write(`${message}\n`);
  return {
    start: () => write('Complete the CAO quickstart'),
    step: (message) => write(`==> ${message}`),
    success: (message) => write(`OK: ${message}`),
    warning: (message) => write(`Warning: ${message}`),
    failure: () => write('Quickstart stopped'),
    finish: write,
  };
}
