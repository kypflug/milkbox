/**
 * The chat switcher — a dialog opened from the chats button in the feed
 * header (top right, mirroring the logomark). Built on the same modal shell
 * as the other chat sheets, so it dismisses like settings: scrim, Escape,
 * close button. Repaints live while open when the registry changes.
 */

import { escapeAttr, escapeHtml } from '../utils/storage';
import * as coordinator from '../services/sync-coordinator';
import { onBroadcast } from '../services/broadcast';
import { openModal } from '../screens/chat-sheets';
import { iconBottle, iconPeople } from './icons';
import type { ChatRecord, ScopeId } from '../types';

export interface ChatSwitcherHandlers {
  /** A row was chosen ('private' or 'chat:<id>'). */
  onSelect(scopeId: ScopeId): void;
  onCreate(): void;
  onManage(chatId: string): void;
  /** A needs-consent chat was tapped — restart the consent flow. */
  onReconnect(chatId: string): void;
}

function chatSubline(chat: ChatRecord): string {
  if (chat.state === 'gone') return 'Access ended';
  if (chat.state === 'needs-consent') return 'Needs OneDrive access';
  if (chat.role === 'host') return 'You host';
  return `Hosted by ${chat.host.name}`;
}

export function showChatSwitcher(currentScopeId: ScopeId, handlers: ChatSwitcherHandlers): void {
  let offCoordinator: () => void = () => {};
  let offBroadcast: () => void = () => {};

  const modal = openModal('Chats', `
    <div class="chat-list"></div>
    <div class="chat-modal-actions">
      <button class="chat-modal-primary" data-action="new-chat">New chat</button>
    </div>
  `, {
    onClose: () => {
      offCoordinator();
      offBroadcast();
    },
  });

  const listEl = modal.body.querySelector<HTMLElement>('.chat-list')!;

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

    listEl.innerHTML = rows.join('');
  }

  modal.body.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    const manageBtn = target.closest<HTMLElement>('[data-manage]');
    if (manageBtn) {
      modal.close();
      handlers.onManage(manageBtn.dataset.manage!);
      return;
    }
    if (target.closest<HTMLElement>('[data-action="new-chat"]')) {
      modal.close();
      handlers.onCreate();
      return;
    }
    const item = target.closest<HTMLElement>('[data-scope]');
    if (!item) return;
    const scopeId = item.dataset.scope! as ScopeId;
    if (scopeId.startsWith('chat:')) {
      void coordinator.loadChats().then(chats => {
        const chat = chats.find(c => `chat:${c.id}` === scopeId);
        modal.close();
        if (chat?.state === 'needs-consent') handlers.onReconnect(chat.id);
        else handlers.onSelect(scopeId);
      }).catch(err => {
        console.debug('[Chats] Switcher selection failed:', err);
        modal.close();
        handlers.onSelect(scopeId);
      });
    } else {
      modal.close();
      handlers.onSelect(scopeId);
    }
  });

  const repaint = () => void paint().catch(err => console.debug('[Chats] Switcher paint failed:', err));

  offCoordinator = coordinator.onCoordinatorEvent(event => {
    if (event.type === 'chats-changed') repaint();
  });
  offBroadcast = onBroadcast(event => {
    if (event.type === 'chats-changed') repaint();
  });

  repaint();
}
