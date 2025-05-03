
let open = document.querySelector('.navbar--icon');
let menu = document.querySelector('.nav--open');
let close = document.querySelector('.nav--open-icon');
let navLinks = document.querySelectorAll('.nav-link');

open.addEventListener('click', function() {
  menu.classList.toggle('close');
});


close.addEventListener('click', function() {
  menu.classList.toggle('close');
})

// Add close behavior when a nav-link is clicked
navLinks.forEach(function(link) {
  link.addEventListener('click', function() {
    menu.classList.add('close'); // ← always close the menu
  });
});
