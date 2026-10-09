// The worker: opens the panel, grants page access, performs page ops.
//
// It holds no conversation and no session state - the panel owns those. Its
// only jobs are the ones that need extension APIs: opening the side panel,
// asking Chrome for one site, injecting the grounding script on demand, and
// performing one page op at a time.
//
// There is no alarm, no declared content script, no listener left in any page,
// and no periodic work. Nothing happens unless the panel asks.
//
// Least privilege has a visible cost here, and it is the right trade: the
// extension does not take the "tabs" permission, so Chrome hides every tab's
// URL and title until the student either clicks the toolbar button (which
// grants activeTab for that one tab, until it navigates) or grants the site.
// When the URL is hidden the panel says so and asks for one of those two
// things, rather than the extension asking for the right to watch every tab.

import { blockedReason, originPattern, pageRules } from '../lib/safety.js'
import { planAction } from '../lib/actions.js'

const OUTLINE_FILE = 'src/content/outline.js'

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id })
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ path: 'src/sidepanel/panel.html', enabled: true })
})

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  handle(message).then(respond, (error) => respond({ ok: false, reason: String(error?.message || error) }))
  return true // the reply is async
})

async function handle(message) {
  switch (message?.kind) {
    case 'tab':
      return describeTab()
    case 'grant':
      return grant(message)
    case 'revoke':
      return revoke(message)
    case 'page':
      return pageOp(message)
    default:
      return { ok: false, reason: `unknown message ${message?.kind}` }
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab || null
}

/** What the panel's header shows: the tab, whether it may be touched, whether it is reachable. */
async function describeTab() {
  const tab = await activeTab()
  if (!tab) return { ok: true, tab: null, blocked: 'There is no tab open here.', granted: false }
  if (!tab.url) {
    // No activeTab and no host permission: Chrome withholds the URL itself.
    return {
      ok: true,
      tab: { id: tab.id, url: '', title: '', host: '' },
      blocked: '',
      granted: false,
      hidden: true,
    }
  }
  const blocked = blockedReason(tab.url)
  const granted = blocked ? false : await chrome.permissions.contains({ origins: [originPattern(tab.url)] })
  return {
    ok: true,
    tab: { id: tab.id, url: tab.url, title: tab.title || '', host: hostOf(tab.url) },
    blocked,
    granted,
    hidden: false,
  }
}

/** Ask Chrome for this one origin. Must be called from a user gesture in the panel. */
async function grant({ url }) {
  const blocked = blockedReason(url || '')
  if (blocked) return { ok: false, reason: blocked }
  const origins = [originPattern(url)]
  const granted = await chrome.permissions.request({ origins })
  return { ok: granted, origins, reason: granted ? '' : 'Chrome did not grant access to this site.' }
}

async function revoke({ url }) {
  try {
    const origins = [originPattern(url)]
    await chrome.permissions.remove({ origins })
    return { ok: true, origins }
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) }
  }
}

/**
 * One page op, checked three times over: the panel refuses to ask without an
 * active session and a granted page, the action registry decides whether the
 * op may run at all, and outline.js checks the element it actually finds.
 * Chrome itself is the fourth check - executeScript fails without permission.
 */
async function pageOp({ op, args = {} }) {
  const tab = await activeTab()
  if (!tab) return { ok: false, reason: 'There is no tab open here.' }
  if (!tab.url) {
    return {
      ok: false,
      reason: 'Plip cannot see which page this is. Click the Plip button in the toolbar on that tab, '
        + 'or grant the site from the panel.',
    }
  }
  const blocked = blockedReason(tab.url)
  if (blocked) return { ok: false, reason: blocked }
  const plan = planAction(actionFor(op), args, { pageGranted: true, pageUrl: tab.url })
  if (plan.outcome === 'refused') return { ok: false, reason: plan.reason }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [OUTLINE_FILE] })
    await call(tab.id, 'configure', pageRules())
    const result = await call(tab.id, op, args)
    return { ...result, host: hostOf(tab.url) }
  } catch (error) {
    const reason = String(error?.message || error)
    if (/cannot access|host permission|extensions gallery|chrome:\/\//i.test(reason)) {
      return {
        ok: false,
        reason: 'Chrome will not let Plip read this page. Grant this site from the panel, or open the '
          + 'panel from the toolbar button on the tab you want help with.',
      }
    }
    return { ok: false, reason }
  }
}

/** Page ops that are not themselves tutor actions still answer to an action's rules. */
function actionFor(op) {
  if (op === 'outline' || op === 'clear_highlight') return 'read_page'
  return op
}

async function call(tabId, op, args) {
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (name, payload) => globalThis.PlipOutline.handle(name, payload),
    args: [op, args],
  })
  return frame?.result ?? { ok: false, reason: 'The page did not answer.' }
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}
