/**
 * The chat switcher — a dropdown hanging off the feed title. The title names
 * the current scope ("Milkbox" or the chat's name), so the menu that changes
 * it lives on it. Built on the native Popover API: a shown popover renders in
 * the top layer, above every z-index, so the window-controls-overlay drag
 * strip can never cover it, and light dismiss and Escape come for free.
 * Repaints live while open when the registry changes.
 */

import { escapeAttr, escapeHtml } from '../utils/storage';
import * as coordinator from '../services/sync-coordinator';
import { onBroadcast } from '../services/broadcast';
import { iconBottle, iconPeople, iconPlus } from './icons';
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

export interface ChatMenuApi {
  teardown(): void;
}

/** Gap between the title strip and the menu, and the viewport gutter. */
const MENU_GAP = 6;
const VIEWPORT_GUTTER = 16;

/**
 * Hang the chat menu off `trigger` (the feed title). The popover mounts in
 * `mount`, which must sit outside the header row: under window-controls-overlay
 * that row is pointer-events: none, and the property inherits.
 */
export function mountChatMenu(
  trigger: HTMLButtonElement,
  mount: HTMLElement,
  currentScopeId: ScopeId,
  handlers: ChatSwitcherHandlers,
): ChatMenuApi {
  const menu = document.createElement('div');
  menu.className = 'chat-menu';
  menu.id = 'chatMenu';
  menu.popover = 'auto';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Chats');
  menu.innerHTML = `
    <div class="chat-list"></div>
    <div class="chat-menu-actions">
      <button class="chat-menu-new" data-action="new-chat">${iconPlus('1em')}<span>New chat</span></button>
    </div>
  `;
  mount.appendChild(menu);

  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', menu.id);
  trigger.setAttribute('aria-expanded', 'false');

  const listEl = menu.querySelector<HTMLElement>('.chat-list')!;
  const isOpen = () => menu.matches(':popover-open');

  async function paint(): Promise<void> {
    const chats = (await coordinator.loadChats()).sort((a, b) => a.joinedAt - b.joinedAt);

    const rows: string[] = [];
    const privateSelected = currentScopeId === 'private';
    rows.push(`
      <div class="chat-row">
        <button class="chat-item chat-item--private${privateSelected ? ' chat-item--selected' : ''}"
                data-scope="private"${privateSelected ? ' aria-current="true"' : ''}>
          <span class="chat-item-glyph">${iconBottle('1.1em')}</span>
          <span class="chat-item-text">
            <span class="chat-item-name">My milkbox</span>
          </span>
        </button>
      </div>`);

    for (const chat of chats) {
      const scopeId: ScopeId = `chat:${chat.id}`;
      const selected = scopeId === currentScopeId;
      const goneClass = chat.state === 'gone' ? ' chat-item--gone' : '';
      const unread = chat.unreadCount ?? 0;
      rows.push(`
        <div class="chat-row">
          <button class="chat-item${selected ? ' chat-item--selected' : ''}${goneClass}"
                  data-scope="${escapeAttr(scopeId)}"${selected ? ' aria-current="true"' : ''}>
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

    // Repaints while open would otherwise drop keyboard focus on the floor.
    const focusedScope = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-scope]')?.dataset.scope;
    listEl.innerHTML = rows.join('');
    if (focusedScope && isOpen()) {
      listEl.querySelector<HTMLElement>(`[data-scope="${CSS.escape(focusedScope)}"]`)?.focus();
    }
    if (isOpen()) position();
  }

  const repaint = () => void paint().catch(err => console.debug('[Chats] Menu paint failed:', err));

  /** Centre under the title, clamped to the viewport; cap the height to the
   *  space below so a long list scrolls inside the menu. */
  function position(): void {
    const anchor = trigger.getBoundingClientRect();
    const header = trigger.closest<HTMLElement>('.feed-header-row')?.getBoundingClientRect();
    const top = Math.max(anchor.bottom, header?.bottom ?? anchor.bottom) + MENU_GAP;
    const width = menu.offsetWidth;
    const centre = anchor.left + anchor.width / 2;
    const maxLeft = window.innerWidth - VIEWPORT_GUTTER - width;
    const left = Math.max(VIEWPORT_GUTTER, Math.min(centre - width / 2, maxLeft));
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.maxHeight = `${Math.max(160, window.innerHeight - top - VIEWPORT_GUTTER)}px`;
  }

  const close = (restoreFocus: boolean) => {
    if (isOpen()) menu.hidePopover();
    if (restoreFocus) trigger.focus();
  };

  // The trigger toggles by hand rather than via popovertarget so the menu
  // can live outside the header (see the mount note above). Light dismiss
  // fires on pointerdown, before this click, so a click that closed the menu
  // must not immediately reopen it.
  let closedByTriggerPress = false;
  const onTriggerPointerDown = () => { closedByTriggerPress = isOpen(); };
  const onTriggerClick = () => {
    if (closedByTriggerPress) {
      closedByTriggerPress = false;
      return;
    }
    if (isOpen()) menu.hidePopover();
    else open();
  };
  // A keyboard press never has a pointerdown, so clear any flag a cancelled
  // pointer press left behind.
  const onTriggerKeyDown = () => { closedByTriggerPress = false; };
  trigger.addEventListener('pointerdown', onTriggerPointerDown);
  trigger.addEventListener('keydown', onTriggerKeyDown);
  trigger.addEventListener('click', onTriggerClick);

  // Position and focus in the same task as showPopover, so no frame ever
  // paints the menu at the UA default spot before it moves under the title.
  function open(): void {
    menu.showPopover();
    position();
    trigger.setAttribute('aria-expanded', 'true');
    (listEl.querySelector<HTMLElement>('[aria-current="true"]') ?? listEl.querySelector<HTMLElement>('.chat-item'))?.focus();
  }

  // Closing can come from light dismiss or Escape as well as from here.
  menu.addEventListener('toggle', e => {
    if ((e as ToggleEvent).newState === 'closed') trigger.setAttribute('aria-expanded', 'false');
  });

  const onResize = () => { if (isOpen()) position(); };
  window.addEventListener('resize', onResize);

  // Escape is handled by the popover itself; this only returns focus to the
  // title, which light dismiss does not do.
  menu.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = [...menu.querySelectorAll<HTMLElement>('.chat-item, .chat-menu-new')];
    if (items.length === 0) return;
    e.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (index === -1) next = e.key === 'ArrowDown' ? 0 : items.length - 1;
    else next = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  });

  menu.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    const manageBtn = target.closest<HTMLElement>('[data-manage]');
    if (manageBtn) {
      close(false);
      handlers.onManage(manageBtn.dataset.manage!);
      return;
    }
    if (target.closest<HTMLElement>('[data-action="new-chat"]')) {
      close(false);
      handlers.onCreate();
      return;
    }
    const item = target.closest<HTMLElement>('[data-scope]');
    if (!item) return;
    const scopeId = item.dataset.scope! as ScopeId;
    close(false);
    if (scopeId.startsWith('chat:')) {
      void coordinator.loadChats().then(chats => {
        const chat = chats.find(c => `chat:${c.id}` === scopeId);
        if (chat?.state === 'needs-consent') handlers.onReconnect(chat.id);
        else handlers.onSelect(scopeId);
      }).catch(err => {
        console.debug('[Chats] Menu selection failed:', err);
        handlers.onSelect(scopeId);
      });
    } else {
      handlers.onSelect(scopeId);
    }
  });

  // Keep the list painted whether or not the menu is open, so opening is
  // instant and never flashes an empty list.
  const offCoordinator = coordinator.onCoordinatorEvent(event => {
    if (event.type === 'chats-changed') repaint();
  });
  const offBroadcast = onBroadcast(event => {
    if (event.type === 'chats-changed') repaint();
  });
  repaint();

  return {
    teardown() {
      offCoordinator();
      offBroadcast();
      window.removeEventListener('resize', onResize);
      trigger.removeEventListener('pointerdown', onTriggerPointerDown);
      trigger.removeEventListener('keydown', onTriggerKeyDown);
      trigger.removeEventListener('click', onTriggerClick);
      if (isOpen()) menu.hidePopover();
      menu.remove();
    },
  };
}
