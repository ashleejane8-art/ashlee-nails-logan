Ashlee Nails - Portfolio zoom + click-to-enlarge

What this does
1) Makes portfolio tiles square + slightly zoomed so the nails look bigger.
2) Adds a click-to-zoom lightbox (full-size preview). Hit ESC or click outside to close.

How to install
A) Replace your existing portfolio-fit.css with the one in this ZIP (same filename), OR merge the CSS into your main stylesheet.
B) Add the JS file:
   - Upload portfolio-lightbox.js to the site root
   - Then add this line right before </body> in index.html:
     <script src="portfolio-lightbox.js"></script>

If one specific photo crops weird, add class "fit-contain" to that card:
  <div class="portfolio-card fit-contain"> ... </div>
