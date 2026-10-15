import { spawnSync } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';

export class SetupCancelled extends Error {}

const ANSI = {
  clearLine: '\r\u001b[2K',
  cyan: '\u001b[36m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  reset: '\u001b[0m',
  yellow: '\u001b[33m',
};

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

function color(code, value) {
  return `${code}${value}${ANSI.reset}`;
}

function writeStyledLine(output, symbol, symbolColor, message) {
  output.write(`${color(symbolColor, symbol)}  ${message}\n`);
}

function createQuestionReader({ input, output }) {
  const controller = new AbortController();
  const terminal = createInterface({ input, output });
  let closed = false;
  terminal.on('SIGINT', () => controller.abort(new SetupCancelled()));

  return {
    async question(message) {
      if (closed) throw new SetupCancelled();
      try {
        return await terminal.question(message, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
      }
    },
    close() {
      closed = true;
      terminal.close();
    },
  };
}

function createNumberedSelect({ text, note }) {
  return async (message, choices) => {
    note(message);
    choices.forEach((choice, index) => note(`  ${index + 1}. ${choice.label}${choice.hint ? ` (${choice.hint})` : ''}`));
    while (true) {
      const value = await text('Choose', '1');
      const index = /^\d+$/.test(value) ? Number(value) - 1 : -1;
      if (choices[index]) return choices[index].value;
      note(`Enter a number from 1 to ${choices.length}.`);
    }
  };
}

function createArrowSelect({ input, output, cancelActive }) {
  return async (message, choices, initialIndex = 0) => {
    if (choices.length === 0) throw new Error(`Prompt has no choices: ${message}`);

    emitKeypressEvents(input);
    const previousRawMode = Boolean(input.isRaw);
    let selected = Math.min(Math.max(initialIndex, 0), choices.length - 1);
    let settled = false;

    return new Promise((resolve, reject) => {
      const render = (redraw = false) => {
        if (redraw) output.write(`\u001b[${choices.length}A`);
        for (const [index, choice] of choices.entries()) {
          const selectedChoice = index === selected;
          const pointer = selectedChoice ? color(ANSI.cyan, '❯') : ' ';
          const label = selectedChoice ? color(ANSI.cyan, choice.label) : choice.label;
          const hint = choice.hint ? color(ANSI.dim, ` (${choice.hint})`) : '';
          output.write(`${ANSI.clearLine}${pointer} ${label}${hint}\n`);
        }
      };
      const cleanup = () => {
        input.off('keypress', onKeypress);
        input.setRawMode(previousRawMode);
        if (cancelActive.current === cancel) cancelActive.current = undefined;
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const cancel = () => finish(reject, new SetupCancelled());
      const onKeypress = (_value, key = {}) => {
        if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
          cancel();
          return;
        }
        if (key.name === 'up' || key.name === 'left') {
          selected = (selected - 1 + choices.length) % choices.length;
          render(true);
          return;
        }
        if (key.name === 'down' || key.name === 'right') {
          selected = (selected + 1) % choices.length;
          render(true);
          return;
        }
        if (key.name === 'return' || key.name === 'enter') finish(resolve, choices[selected].value);
      };

      cancelActive.current = cancel;
      input.setRawMode(true);
      input.on('keypress', onKeypress);
      input.resume();
      output.write(`${color(ANSI.cyan, '◆')}  ${message}\n`);
      render();
    });
  };
}

export function createTerminalPrompt({ input, output, UsageError }) {
  if (!input.isTTY || !output.isTTY) {
    throw new UsageError('cao setup requires an interactive terminal. Run ./cao.sh setup from a terminal; use ./cao.sh setup-auth for scripted authentication.');
  }

  const styled = styledPromptsEnabled({ input, output });
  const reader = createQuestionReader({ input, output });
  const cancelActive = { current: undefined };
  const plainNote = (message, title) => output.write(`${title ? `${title}\n` : ''}${message}\n`);
  const styledNote = (message, title) => {
    if (title) writeStyledLine(output, '◇', ANSI.cyan, title);
    for (const line of String(message).split('\n')) output.write(`${color(ANSI.dim, '│')}  ${line}\n`);
  };
  const note = styled ? styledNote : plainNote;
  const text = async (message, defaultValue = '', validate) => {
    while (true) {
      const suffix = defaultValue ? ` [${defaultValue}]` : '';
      const prefix = styled ? `${color(ANSI.cyan, '◆')}  ` : '';
      const value = (await reader.question(`${prefix}${message}${suffix}: `)).trim() || defaultValue;
      const error = validate?.(value);
      if (!error) return value;
      if (styled) writeStyledLine(output, '▲', ANSI.yellow, error);
      else note(error);
    }
  };
  const numberedSelect = createNumberedSelect({ text, note });
  const arrowSelect = styled && typeof input.setRawMode === 'function'
    ? createArrowSelect({ input, output, cancelActive })
    : undefined;

  return {
    start: () => styled
      ? writeStyledLine(output, '◆', ANSI.cyan, 'Set up Central Agentic Ops')
      : note('Set up Central Agentic Ops'),
    step: (message) => styled ? writeStyledLine(output, '◇', ANSI.cyan, message) : note(message),
    note,
    text,
    async select(message, choices) {
      if (arrowSelect) return await arrowSelect(message, choices);
      return numberedSelect(message, choices);
    },
    async confirm(message) {
      if (arrowSelect) {
        return await arrowSelect(message, [
          { label: 'Yes', value: true },
          { label: 'No', value: false },
        ], 1);
      }
      const value = (await reader.question(`${message} [y/N]: `)).trim().toLowerCase();
      return value === 'y' || value === 'yes';
    },
    cancel: (message) => styled ? writeStyledLine(output, '■', ANSI.red, message) : note(message),
    finish: () => styled
      ? writeStyledLine(output, '◇', ANSI.green, 'Configuration saved. No campaigns installed or run.')
      : note('Configuration saved. No campaigns installed or run.'),
    failure: () => styled
      ? writeStyledLine(output, '▲', ANSI.red, 'Setup stopped. See the recovery guidance below.')
      : note('Setup stopped. See the recovery guidance below.'),
    close() {
      cancelActive.current?.();
      reader.close();
    },
  };
}

function truncateActiveMessage(message, columns, suffixLength) {
  const available = Math.max(1, columns - suffixLength - 4);
  if (message.length <= available) return message;
  if (available <= 3) return '.'.repeat(available);
  return `${message.slice(0, Math.max(1, available - 3))}...`;
}

export function createQuickstartProgress({
  input = process.stdin,
  output = process.stderr,
  environment = process.env,
} = {}) {
  if (styledPromptsEnabled({ input, output, environment })) {
    let active;
    const clear = () => {
      if (!active) return;
      clearInterval(active.interval);
      output.write(ANSI.clearLine);
      active = undefined;
    };
    const elapsedSeconds = () => Math.floor((Date.now() - active.startedAt) / 1000);
    const render = () => {
      if (!active) return;
      const elapsed = elapsedSeconds();
      if (elapsed === active.lastElapsed) return;
      active.lastElapsed = elapsed;
      const suffix = ` · ${elapsed}s elapsed`;
      const message = truncateActiveMessage(active.message, output.columns || 80, suffix.length);
      const frame = elapsed % 2 === 0 ? '◇' : '◈';
      output.write(`${ANSI.clearLine}${color(ANSI.cyan, frame)}  ${message}${color(ANSI.dim, suffix)}`);
    };
    const settle = (symbol, symbolColor, message) => {
      if (!active) {
        writeStyledLine(output, symbol, symbolColor, message);
        return;
      }
      const elapsed = elapsedSeconds();
      clear();
      writeStyledLine(output, symbol, symbolColor, `${message} ${color(ANSI.dim, `[${elapsed}s]`)}`);
    };
    return {
      start() {},
      note(message, title) {
        clear();
        if (title) writeStyledLine(output, '◇', ANSI.cyan, title);
        for (const line of String(message).split('\n')) output.write(`   ${line}\n`);
      },
      async step(message) {
        clear();
        active = {
          message,
          startedAt: Date.now(),
          lastElapsed: -1,
          interval: undefined,
        };
        render();
        active.interval = setInterval(render, 100);
        active.interval.unref?.();
        await Promise.resolve();
      },
      success: (message) => settle('◇', ANSI.green, message),
      warning: (message) => settle('▲', ANSI.yellow, message),
      failure: () => settle('▲', ANSI.red, 'Quickstart stopped'),
      finish(message) {
        clear();
        writeStyledLine(output, '◇', ANSI.green, message);
      },
    };
  }

  const write = (message) => output.write(`${message}\n`);
  return {
    start() {},
    note(message, title) {
      if (title) write(title);
      write(message);
    },
    step: (message) => write(`==> ${message}`),
    success: (message) => write(`OK: ${message}`),
    warning: (message) => write(`Warning: ${message}`),
    failure: () => write('Quickstart stopped'),
    finish: write,
  };
}
