// Portfolio click-to-zoom lightbox
(function () {
  function openLightbox(src, alt) {
    const overlay = document.createElement('div');
    overlay.className = 'lightbox';
    overlay.setAttribute('role','dialog');
    overlay.setAttribute('aria-label','Image preview');

    const img = document.createElement('img');
    img.src = src;
    img.alt = alt || 'Portfolio image';

    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label','Close');

    function cleanup(){
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    }
    function onKey(e){
      if(e.key === 'Escape') cleanup();
    }

    close.addEventListener('click', cleanup);
    overlay.addEventListener('click', function(e){
      if(e.target === overlay) cleanup();
    });
    document.addEventListener('keydown', onKey);

    overlay.appendChild(img);
    overlay.appendChild(close);
    document.body.appendChild(overlay);
  }

  // Click any image inside .portfolio-card
  document.addEventListener('click', function (e) {
    const img = e.target && e.target.closest && e.target.closest('.portfolio-card img');
    if (!img) return;
    e.preventDefault();
    openLightbox(img.src, img.alt);
  });
})();
