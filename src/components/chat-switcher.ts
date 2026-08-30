/**
 * The chat switcher — a slide-out drawer on narrow screens, a persistent
 * left rail beside the feed pane at the desktop "pane" breakpoint (the CSS
 * in chats.css decides which; this component renders one DOM either way).
 *
 * Rows are <button> elements throughout: the house focus-trap convention
 * (settings.ts) only recognises button/input, and buttons get key handling
 * for free.
 */

import { escapeAttr, escapeHtml } from '../utils/storage';
import * as coordinator from '../services/sync-coordinator';
import { onBroadcast } from '../services/broadcast';
import { iconBottle, iconClose, iconPeople, iconPlus } from './icons';
import type { ChatRecord, ScopeId } from '../types';

export interface ChatSwitcherHandlers {
  /** A row was chosen ('private' or 'chat:<id>'). */
  onSelect(scopeId: ScopeId): void;
  onCreate(): void;
  onManage(chatId: string): void;
  /** A needs-consent chat was tapped — restart the consent flow. */
  onReconnect(chatId: string): void;
}

export interface ChatSwitcherApi {
  open(): void;
  close(): void;
  toggle(): void;
  teardown(): void;
}

function chatSubline(chat: ChatRecord): string {
  if (chat.state === 'gone') return 'Access ended';
  if (chat.state === 'needs-consent') return 'Needs OneDrive access';
  if (chat.role === 'host') return 'You host';
  return `Hosted by ${chat.host.name}`;
}

export function mountChatSwitcher(
  app: HTMLElement,
  currentScopeId: ScopeId,
  handlers: ChatSwitcherHandlers,
): ChatSwitcherApi {
  const rail = document.createElement('aside');
  rail.className = 'chat-rail';
  rail.setAttribute('aria-label', 'Chats');
  const scrim = document.createElement('div');
  scrim.className = 'chat-scrim';
  scrim.hidden = true;

  // The rail must precede the feed screen so the pane-mode row layout puts
  // it on the left.
  app.prepend(rail);
  app.appendChild(scrim);

  async function paint(): Promise<void> {
    const chats = (await coordinator.loadChats()).sort((a, b) => a.joinedAt - b.joinedAt);

    const rows: string[] = [];
    const privateSelected = currentScopeId === 'private' ? ' chat-item--selected' : '';
    rows.push(`
      <div class="chat-row">
        <button class="chat-item chat-item--private${privateSelected}" data-scope="private">
          <span class="chat-item-glyph">${iconBottle('1.1em')}</span>
          <span class="chat-item-text">
            <span class="chat-item-name">My milkbox</span>
          </span>
        </button>
      </div>`);

    for (const chat of chats) {
      const scopeId: ScopeId = `chat:${chat.id}`;
      const selected = scopeId === currentScopeId ? ' chat-item--selected' : '';
      const goneClass = chat.state === 'gone' ? ' chat-item--gone' : '';
      const unread = chat.unreadCount ?? 0;
      rows.push(`
        <div class="chat-row">
          <button class="chat-item${selected}${goneClass}" data-scope="${escapeAttr(scopeId)}">
            <span class="chat-item-glyph">${iconPeople('1.1em')}</span>
            <span class="chat-item-text">
              <span class="chat-item-name">${escapeHtml(chat.name)}</span>
              <span class="chat-item-sub">${escapeHtml(chatSubline(chat))}</span>
            </span>
            <span class="chat-unread-badge"${unread > 0 ? '' : ' hidden'}>${unread > 99 ? '99+' : unread}</span>
          </button>
          <button class="chat-manage" data-manage="${escapeAttr(chat.id)}" title="Chat options" aria-label="Options for ${escapeAttr(chat.name)}">${iconPeople('1em')}</button>
        </div>`);
    }

    rail.innerHTML = `
      <div class="chat-rail-header">
        <span class="chat-rail-title">Chats</span>
        <button class="chat-rail-new" data-action="new-chat" title="New chat" aria-label="New chat">${iconPlus('1.1em')}</button>
        <button class="chat-rail-close" data-action="close" title="Close" aria-label="Close chat list">${iconClose('1.05em')}</button>
      </div>
      <div class="chat-list">${rows.join('')}</div>
    `;
  }

  function open(): void {
    rail.setAttribute('data-open', '');
    scrim.hidden = false;
  }

  function close(): void {
    rail.removeAttribute('data-open');
    scrim.hidden = true;
  }

  function toggle(): void {
    if (rail.hasAttribute('data-open')) close();
    else open();
  }

  rail.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    const manageBtn = target.closest<HTMLElement>('[data-manage]');
    if (manageBtn) {
      close();
      handlers.onManage(manageBtn.dataset.manage!);
      return;
    }
    const actionBtn = target.closest<HTMLElement>('[data-action]');
    if (actionBtn) {
      if (actionBtn.dataset.action === 'close') close();
      if (actionBtn.dataset.action === 'new-chat') {
        close();
        handlers.onCreate();
      }
      return;
    }
    const item = target.closest<HTMLElement>('[data-scope]');
    if (!item) return;
    const scopeId = item.dataset.scope! as ScopeId;
    close();
    if (scopeId.startsWith('chat:')) {
      void coordinator.loadChats().then(chats => {
        const chat = chats.find(c => `chat:${c.id}` === scopeId);
        if (chat?.state === 'needs-consent') handlers.onReconnect(chat.id);
        else handlers.onSelect(scopeId);
      });
    } else {
      handlers.onSelect(scopeId);
    }
  });

  scrim.addEventListener('click', close);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && rail.hasAttribute('data-open')) close();
  };
  document.addEventListener('keydown', onKeyDown);

  const offCoordinator = coordinator.onCoordinatorEvent(event => {
    if (event.type === 'chats-changed') void paint();
  });
  const offBroadcast = onBroadcast(event => {
    if (event.type === 'chats-changed') void paint();
  });

  void paint();

  return {
    open,
    close,
    toggle,
    teardown() {
      document.removeEventListener('keydown', onKeyDown);
      offCoordinator();
      offBroadcast();
      rail.remove();
      scrim.remove();
    },
  };
}
