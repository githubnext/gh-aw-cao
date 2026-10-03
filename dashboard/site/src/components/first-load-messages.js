import { createDebug } from '../debug.js';

const debugFirstLoadMessages = createDebug('first-load-messages');

export const FIRST_LOAD_MESSAGE_INTERVAL_MS = 6_000;

export const FIRST_LOAD_MESSAGES = [
  'Good things start with a little preparation.',
  'A fresh browser, a fresh perspective.',
  'Making space for the bigger picture.',
  'A little setup now, a clearer view later.',
  'Your next useful question starts here.',
  'Every useful dashboard begins with evidence.',
  'Taking a moment to set the scene.',
  'A clearer picture is worth a little preparation.',
  'Welcome to a new view of your campaigns.',
  'First visits need a little extra groundwork.',
  'Think of this as unpacking your dashboard.',
  'A calm place to make sense of campaign activity.',
  'Your browser is getting its own local workspace.',
  'There is a story behind every snapshot.',
  'A little patience, a lot of context.',
  'Turning a first visit into familiar territory.',
  'A little scaffolding for your next big question.',
  'A thoughtful overview starts with the details.',
  'A fresh start for your next investigation.',
  'Let the snapshot set the scene.',
  'The latest published snapshot is our starting point.',
  'Published activity is a snapshot, not a live feed.',
  'Every chart deserves a little context.',
  'Setting the table for a useful overview.',
  'Good context makes good company.',
  'An empty browser cache is just a beginning.',
  'First the groundwork, then the exploration.',
  'A new view starts with a fresh snapshot.',
  'Counts are clues, not conclusions.',
  'There is more to the story than a run count.',
  'The best next step starts with a good question.',
  'Bring your curiosity. The overview brings the context.',
  'Freshness matters as much as the numbers.',
  'A thoughtful question can open up a useful view.',
  'Knowing what is missing is useful, too.',
  'Campaign activity has more than one dimension.',
  'A snapshot is a starting point for investigation.',
  'A little context goes a long way.',
  'A good overview makes the next question easier.',
  'Small details can explain a big trend.',
  'You can explore while the import continues.',
  'Dismissing this screen does not cancel the import.',
  'Overview can bring you back to this screen.',
  'Keep this tab open while your snapshot takes shape.',
  'Your first import gives future visits a head start.',
  'Cached data can make your next visit more familiar.',
  'This local copy belongs to this browser.',
  'Another browser prepares its own local snapshot.',
  'The progress indicator tracks the actual import.',
  'These little notes are company, not progress estimates.',
  'Feel free to look around while the import continues.',
  'The dashboard can keep preparing while you browse.',
  'A fresh page for the work ahead.',
  'Making a home for the details in this browser.',
  'Think of the overview as your starting point.',
  'Your campaigns keep their own pace.',
  'Good views are built on good foundations.',
  'One dashboard, plenty of paths to explore.',
  'A helpful pause before a closer look.',
  'Let curiosity lead your next view.',
  'Your next question has a place to start.',
  'A closer look can begin with a single detail.',
  'A place to explore the repositories in scope.',
  'Room to look at one campaign or the wider picture.',
  'Time windows give trends their context.',
  'A useful comparison starts with clear evidence.',
  'Freshness is part of the story.',
  'Every run has a little more to tell.',
  'There is more than one way to explore a snapshot.',
  'A clearer view can help frame the next decision.',
  'Room for the details, space for the big picture.',
  'Less guesswork begins with better context.',
  'Every investigation deserves a solid starting point.',
  'Good questions are always welcome here.',
  'A patient first look can reveal a useful detail.',
  'A place for clarity, not just charts.',
  'Context turns numbers into useful questions.',
  'A handy map for your next investigation.',
  'Evidence helps you choose where to look next.',
  'A little structure leaves more room for curiosity.',
  'Making your first look a more informed one.',
  'Start broad, then follow the evidence.',
  'Trends are more useful with their time window.',
  'The details and the big picture make a good team.',
  'A little groundwork supports a better overview.',
  'A fresh perspective on familiar activity.',
  'A workspace for the signals worth a closer look.',
  'There is room for a thoughtful look.',
  'A quiet moment before your next useful insight.',
  'The first page is only the start of the exploration.',
  'A small warm-up for a clearer view.',
  'The first visit lays the groundwork.',
  'The overview starts with the evidence.',
  'A local starting point for a wider perspective.',
  'A little setup behind your next useful view.',
  'Numbers and context belong together.',
  'A steady foundation for a fresh perspective.',
  'A welcoming place for your next useful question.',
  'Let the evidence tell the story.',
  'Thanks for making room for a thoughtful first look.'
];

/** Randomized presentation copy, with every message used once per cycle. */
export function createFirstLoadMessagePicker() {
  /** @type {string[]} */
  let remaining = [];
  let previous = '';
  let cycleCount = 0;
  debugFirstLoadMessages({ event: 'picker-created', messageCount: FIRST_LOAD_MESSAGES.length });
  return () => {
    if (!remaining.length) {
      remaining = [...FIRST_LOAD_MESSAGES];
      for (let index = remaining.length - 1; index > 0; index -= 1) {
        const other = Math.floor(Math.random() * (index + 1));
        [remaining[index], remaining[other]] = [remaining[other], remaining[index]];
      }
      if (remaining.at(-1) === previous) {
        const last = remaining.length - 1;
        [remaining[0], remaining[last]] = [remaining[last], remaining[0]];
      }
      cycleCount += 1;
      debugFirstLoadMessages({ event: 'cycle-reshuffled', cycleCount });
    }
    const next = remaining.pop();
    if (!next) throw new Error('First-load presentation messages are missing.');
    previous = next;
    return next;
  };
}
