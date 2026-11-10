// Nanni Stories: category filter + search on listing pages, TOC and copy-link on posts.
// Progressive enhancement only: with JS off every card shows and chips are plain links.
(function () {
  var d = document;

  var list = d.querySelector('[data-stories]');
  if (list) {
    var cards = [].slice.call(list.querySelectorAll('.story-grid [data-cats]'));
    var chips = [].slice.call(list.querySelectorAll('[data-filter]'));
    var box = list.querySelector('[data-search-box]');
    var input = d.getElementById('story-search');
    var featured = list.querySelector('[data-featured-section]');
    var empty = list.querySelector('[data-empty]');
    var count = list.querySelector('[data-count]');
    var home = list.dataset.category || '';
    var cat = home;
    box.hidden = false;

    var apply = function () {
      var q = input.value.trim().toLowerCase();
      var filtering = q !== '' || cat !== home;
      var shown = 0;
      cards.forEach(function (card) {
        var ok = (!cat || card.dataset.cats.split(' ').indexOf(cat) > -1) &&
          (!q || card.dataset.search.indexOf(q) > -1);
        // The latest story is shown as the featured card unless a filter is active.
        card.hidden = !ok || (!filtering && card.hasAttribute('data-featured'));
        if (ok) shown++;
      });
      featured.hidden = filtering;
      empty.hidden = shown > 0;
      count.textContent = filtering ? (shown === 1 ? '1 story' : shown + ' stories') + (q ? ' matching “' + input.value.trim() + '”' : '') : '';
    };

    // Only the all-stories page has every card, so only there can chips filter in place.
    if (list.hasAttribute('data-all')) {
      chips.forEach(function (chip) {
        chip.addEventListener('click', function (e) {
          e.preventDefault();
          cat = chip.dataset.filter;
          chips.forEach(function (c) {
            if (c === chip) c.setAttribute('aria-current', 'page');
            else c.removeAttribute('aria-current');
          });
          if (window.history.replaceState) window.history.replaceState(null, '', chip.href);
          apply();
        });
      });
    }
    input.addEventListener('input', apply);
  }

  var toc = d.querySelector('.story-toc details');
  if (toc && window.matchMedia('(max-width: 1199.98px)').matches) toc.open = false;

  [].forEach.call(d.querySelectorAll('[data-copy]'), function (link) {
    link.addEventListener('click', function (e) {
      if (!navigator.clipboard) return;
      e.preventDefault();
      var label = link.querySelector('span');
      var status = d.querySelector('[data-copy-status]');
      navigator.clipboard.writeText(link.href).then(function () {
        label.textContent = 'Link copied';
        if (status) status.textContent = 'Link copied to clipboard';
        setTimeout(function () {
          label.textContent = 'Copy link';
        }, 2000);
      });
    });
  });
})();
