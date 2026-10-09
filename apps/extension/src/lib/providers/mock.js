// The local tutor. No network, no credentials, no model.
//
// It exists so the extension is fully usable (and testable, and demoable) with
// nothing configured, and so the panel's streaming path is the same one a real
// model goes through. It is deliberately simple: a few rules over the student's
// words and the page outline. It is not a model and never claims to be.

const ANSWER_ASK = /\b(what('s| is) the answer|give me the answer|answer (it|this|these|for me)|do (it|this|my homework|the assignment) for me|solve (it|this) for me|just tell me|write (it|my essay|the essay)|fill (it|this) in|submit (it|this)|finish (it|this) for me)\b/i
const STUCK = /\b(stuck|don't (get|understand)|dont (get|understand)|no idea|confused|lost|help)\b/i
const CHECK = /\b(is (this|that|it) right|did i get|check (my|this)|am i (right|correct)|does (this|that) look right)\b/i
const WHY = /\b(why|how come|how does|what does .* mean|explain)\b/i
const DONE = /\b(got it|i get it|that worked|makes sense|thanks|finished|done)\b/i

function prompty(outline) {
  // The most question-shaped line in the outline, with its ref.
  const items = outline || []
  const scored = items
    .filter((item) => item.text && item.text.length > 8)
    .map((item) => {
      let score = 0
      if (/[?=]/.test(item.text)) score += 3
      if (/\b(solve|find|calculate|explain|compare|write|show)\b/i.test(item.text)) score += 2
      if (item.role === 'heading') score += 1
      return { item, score }
    })
    .sort((left, right) => right.score - left.score)
  return scored.length && scored[0].score > 0 ? scored[0].item : items[0] || null
}

function reply({ text, page, selection, task }) {
  const outline = page?.outline || []
  const focus = prompty(outline)
  const point = focus
    ? `[POINT:${focus.ref}:${(focus.text || 'this part').split(/\s+/).slice(0, 3).join(' ')}]`
    : '[POINT:none]'
  const what = selection ? 'what you selected' : focus ? 'the question' : 'the problem'
  // No page access is worth saying, but it is no reason to stop helping: say
  // it, then carry on with the same tutoring.
  const note = page
    ? ''
    : "I can't see the page yet, so grant me this tab from the panel or tell me the question in your own "
      + 'words. '

  if (ANSWER_ASK.test(text)) {
    return `I don't hand over answers to work you're being marked on \u2014 that would be me doing it, `
      + `not you. What I can do is get you to the next step. Look at ${what} again. ${point} `
      + 'What is the very first thing it asks you to find?'
  }
  if (CHECK.test(text)) {
    return `${note}Let's check it together rather than me grading it. Walk me through how you got there, `
      + 'one step. Which bit are you least sure about?'
  }
  if (STUCK.test(text)) {
    return `${note}[STEPS:3][PLAN: read the question | name what's given | pick the method] `
      + `Fine, stuck is a normal place to be. Start with step one: read ${what} out loud to yourself. `
      + `${point} What is it giving you, and what is it asking for?`
  }
  if (WHY.test(text)) {
    return `${note}Good question to be asking. Before I explain, tell me what you think it means so far, `
      + "even a rough guess. What's your hunch?"
  }
  if (DONE.test(text)) {
    return `${note}Nice. Say in one sentence what the trick was, in your own words \u2014 that's what `
      + `makes it stick. [DO:suggest_concepts {"conceptIds": ["${conceptGuess(task, page)}"]}]`
  }
  if (!page) {
    return `${note}What is it asking you to do, in your own words?`
  }
  return `I'm reading ${page.title ? `"${page.title}"` : 'this page'} with you. ${point} `
    + 'Tell me where you are with it: what have you tried so far?'
}

function conceptGuess(task, page) {
  const text = `${task?.label || ''} ${page?.title || ''}`.toLowerCase()
  if (/fraction/.test(text)) return 'fractions.equivalent'
  if (/essay|thesis|paragraph/.test(text)) return 'essay.thesis'
  if (/equation|algebra|solve for/.test(text)) return 'algebra.linear-equations'
  if (/photosynth|cell|biolog/.test(text)) return 'biology.photosynthesis'
  return 'general.problem-solving'
}

export const mockProvider = {
  name: 'mock',
  label: 'Local practice tutor (no model, no network)',
  needsProxy: false,

  /** Streams the reply in small pieces, like a model would. */
  async *stream({ turns, context }) {
    const last = [...turns].reverse().find((turn) => turn.role === 'user')
    const text = last?.text || ''
    const full = reply({ text, ...context })
    // Chunk on whitespace so tag-straddling chunks exercise the parser.
    const pieces = full.match(/\S+\s*/g) || []
    for (const piece of pieces) {
      yield piece
      await new Promise((resolve) => setTimeout(resolve, 8))
    }
  },
}
