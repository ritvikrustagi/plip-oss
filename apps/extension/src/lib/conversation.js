// Provider-neutral conversation turns, ported from
// src/mcp_vision/buddy/conversation.py.
//
// History rides along on every model call, so it stays lean: when a
// multi-step request finishes, its steps fold into one exchange. The macOS
// version also carries screenshots on the current turn; there are none here.

export class Conversation {
  constructor({ maxTurns = 10 } = {}) {
    this.maxTurns = maxTurns
    this.turns = []
    this.requests = 0
  }

  history() {
    return [...this.turns]
  }

  /** One exchange. `step`: Plip's own follow-up within a request (an action result, a check-in). */
  record(userText, assistantText, { step = false } = {}) {
    if (!userText.trim() || !assistantText.trim()) return
    if (!step || !this.requests) this.requests += 1
    this.turns.push({ role: 'user', text: userText, request: this.requests })
    this.turns.push({ role: 'assistant', text: assistantText, request: this.requests })
    let overflow = this.turns.length - this.maxTurns
    if (overflow > 0) {
      // Drop a few exchanges at once, not one per turn: the history is the
      // start of every prompt, and a start that shifts each turn is never read
      // back from the prompt cache. Whole exchanges, so it always starts with
      // a user turn.
      overflow = Math.max(overflow, Math.floor(this.maxTurns / 4))
      overflow += overflow % 2
      this.turns.splice(0, overflow)
    }
  }

  /** The latest request is done: its steps become one exchange. */
  fold() {
    const mine = this.turns.filter((turn) => turn.request === this.requests)
    if (mine.length <= 2 || mine[0].role !== 'user') return
    const said = mine.filter((turn) => turn.role === 'assistant').map((turn) => turn.text).join(' ')
    this.turns = this.turns.filter((turn) => turn.request !== this.requests)
    this.turns.push(mine[0], { role: 'assistant', text: said, request: this.requests })
  }

  clear() {
    this.turns = []
  }
}
