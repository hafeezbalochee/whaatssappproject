const fetch = require('node-fetch');

setInterval(() => {
  fetch('https://whatsappproject.onrender.com')
    .then(res => console.log('Ping successful', res.status))
    .catch(err => console.log('Ping failed', err));
}, 300000); // ہر 5 منٹ میں پنگ
