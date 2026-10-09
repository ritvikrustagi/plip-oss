// What this extension can and cannot do, next to Plip on macOS.
//
// Shown in the panel's "What Plip can't do here" view and rendered into
// docs/EXTENSION.md, so the two can never drift. A pure Chrome extension has
// no desktop, so several of Plip's defining features are simply absent -
// saying so plainly is the point of this file. Nothing here is made possible
// by a native helper, because this extension does not have one and does not
// want one.

export const CAPABILITIES = [
  {
    feature: 'Chat with a tutor',
    mac: 'yes, push-to-talk in the notch',
    extension: 'yes, typed in the side panel; voice optional',
  },
  {
    feature: 'See what you are working on',
    mac: 'yes, screenshots of every display',
    extension: 'no screenshots at all. It reads the DOM of one tab you grant, nothing else',
  },
  {
    feature: 'Point at things',
    mac: 'yes, flies out of the notch and points at screen pixels',
    extension: 'yes, outlines a DOM element in the granted page',
  },
  {
    feature: 'Walkthrough checklist',
    mac: 'yes, in the notch',
    extension: 'yes, in the side panel',
  },
  {
    feature: 'Notch / mascot / desktop overlay',
    mac: 'yes, that is the whole idea',
    extension: 'impossible. An extension cannot draw outside the browser',
  },
  {
    feature: 'Other apps, the menu bar, the Dock',
    mac: 'yes, opens apps and drives them',
    extension: 'impossible. There is no access to anything outside Chrome',
  },
  {
    feature: 'Files on disk',
    mac: 'yes, Spotlight search, open, reveal, tidy the desktop',
    extension: 'no. Only what a page shows, and file:// pages are off unless Chrome is '
      + 'explicitly told to allow them',
  },
  {
    feature: 'Typing, clicking and keystrokes anywhere',
    mac: 'yes, with a confirmation for risky ones',
    extension: 'deliberately not. No typing or keystrokes at all; clicks only on a control you '
      + 'confirm, and never on send, pay, post or submit',
  },
  {
    feature: 'System settings, Shortcuts, reminders, timers',
    mac: 'yes',
    extension: 'impossible from an extension',
  },
  {
    feature: 'Speech out (text to speech)',
    mac: 'yes, every reply is spoken',
    extension: 'not implemented. Replies are read in the panel',
  },
  {
    feature: 'Speech in',
    mac: 'yes, push-to-talk with a local model',
    extension: 'optional and off by default, using Chrome’s own speech recognition, which '
      + 'sends audio to Google. Typing is always available instead',
  },
  {
    feature: 'Learning events for a teacher',
    mac: 'not implemented there',
    extension: 'yes, contract v1, opt-in, exported as a file you can read first',
  },
  {
    feature: 'Works on a managed Chromebook',
    mac: 'no',
    extension: 'designed for it, but not verified on real Chromebook hardware',
  },
]

/** A markdown table, so the docs and the panel say the same thing. */
export function capabilityTable() {
  const header = '| Feature | Plip on macOS | This extension |\n| --- | --- | --- |'
  const rows = CAPABILITIES.map((row) => `| ${row.feature} | ${row.mac} | ${row.extension} |`)
  return [header, ...rows].join('\n')
}
