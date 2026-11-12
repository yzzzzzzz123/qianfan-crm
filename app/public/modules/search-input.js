const composingInputs = new WeakSet();

export function isSearchComposing(input = document.activeElement) {
  return composingInputs.has(input);
}

export function isCompositionEvent(event) {
  // Some browsers report key code 229 even when isComposing is false.
  return event.isComposing || event.keyCode === 229 || isSearchComposing(event.target);
}

export function bindCommittedSearch(root, selector, commit, cancelPending = () => {}) {
  root.addEventListener('compositionstart', event => {
    if (!event.target.matches?.(selector)) return;
    composingInputs.add(event.target);
    cancelPending();
  });
  root.addEventListener('compositionend', event => {
    if (!event.target.matches?.(selector)) return;
    composingInputs.delete(event.target);
    commit(event.target);
  });
  root.addEventListener('input', event => {
    if (!event.target.matches?.(selector)) return;
    if (isCompositionEvent(event)) {
      cancelPending();
      return;
    }
    commit(event.target);
  });
}
