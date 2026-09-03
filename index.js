const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

let sock = null;
let currentQr = null;
let connectionStatus = 'OFFLINE'; // 'OFFLINE' | 'CONNECTING' | 'CONNECTED'

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ['Laptop Express Bot', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'CONNECTING';
      try {
        currentQr = await QRCode.toDataURL(qr);
        console.log('⚡ Yeni QR Kod Üretildi!');
      } catch (err) {
        console.error('QR Kod dönüştürme hatası:', err);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log('Bağlantı kapandı, yeniden bağlanılıyor mu?:', shouldReconnect);
      connectionStatus = 'OFFLINE';
      currentQr = null;
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✓ WhatsApp Bağlantısı Başarıyla Kuruldu!');
      connectionStatus = 'CONNECTED';
      currentQr = null;
    }
  });

  // WhatsApp Sohbetinden Gelen Yanıtları Dinleme (Fiyat Verildiğinde Çalışır)
  sock.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      const msg = chatUpdate.messages[0];
      if (!msg) return;

      const messageContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      const contextInfo = msg.message?.extendedTextMessage?.contextInfo;

      // Eğer mesaj bir bildirime "Reply" yapılarak gönderildiyse
      if (contextInfo && contextInfo.quotedMessage) {
        const quotedText =
          contextInfo.quotedMessage.conversation ||
          contextInfo.quotedMessage.extendedTextMessage?.text ||
          '';

        console.log('📌 Alıntı Yapılan Mesaj:', quotedText);
        console.log('💬 Yazılan Fiyat Yanıtı:', messageContent);

        // Bildirim mesajının içinde "YENİ TEKLİF TALEBİ" veya "Müşteri" / "Telefon" geçiyor mu?
        if (quotedText.includes('TEKLİF TALEBİ') || quotedText.includes('Telefon:')) {
          const offerPrice = messageContent ? messageContent.trim() : null;

          // Mesajın içinden telefon numarasını bul
          const phoneMatch = quotedText.match(/(?:Telefon|📞):\s*([0-9+\s()-]+)/i);

          if (phoneMatch && offerPrice) {
            const rawPhone = phoneMatch[1].trim();

            let cleanPhone = rawPhone.replace(/\D/g, '');
            if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.substring(1);
            if (!cleanPhone.startsWith('90')) cleanPhone = '90' + cleanPhone;

            const targetJid = `${cleanPhone}@s.whatsapp.net`;
            console.log(`🎯 Müşteri Hedef JID: ${targetJid}`);

            // Müşteriye Gönderilecek Fiyat Teklifi Mesajı
            const customerMessage = `Merhaba,\n\nLaptop Express üzerinden ilettiğiniz cihaz teklif talebiniz incelenmiştir.\n\n💰 *Firmamızın Değerleme Teklifi:* *${offerPrice} TL*\n\nTeklifi onaylıyorsanız mağazamızda veya adresinizde nakit ödeme işleminizi anında tamamlayabiliriz.`;

            // Müşterinin WhatsApp'ına Mesaj Gönder
            await sock.sendMessage(targetJid, { text: customerMessage });
            console.log(`✓ Müşteriye (${targetJid}) teklif mesajı başarıyla iletildi!`);

            // Kendi Sohbetine Onay Mesajı Düş
            const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            await sock.sendMessage(myJid, {
              text: `✓ *${offerPrice} TL* teklifiniz müşteriye (${rawPhone}) başarıyla iletildi!`
            });
          } else {
            console.log('⚠️ Telefon numarası veya fiyat okunamadı.');
          }
        }
      }
    } catch (err) {
      console.error('❌ Mesaj yanıtı işleme hatası:', err);
    }
  });

// ---------------- REST API ENDPOINTS ----------------

// 1. Bot Durumu ve QR Kod Endpoint'i
app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    qr: currentQr,
    user: sock?.user?.id ? sock.user.id.split(':')[0] : null
  });
});

// 2. Web Sitesinden Teklif Geldiğinde Tetiklenen Endpoint
app.post('/send-offer', async (req, res) => {
  try {
    const offer = req.body;

    if (!offer || !offer.telefon) {
      return res.status(400).json({ error: 'Eksik teklif verisi' });
    }

    const offerId = offer.id || 'Yeni';

    // Kendi WhatsApp Sohbetine Düşecek Bildirim Mesajı
    const adminNotification = `📩 *YENİ TEKLİF TALEBİ (#${offerId})*\n\n` +
      `👤 *Müşteri:* ${offer.musteri_adi || 'Belirtilmedi'}\n` +
      `📞 *Telefon:* ${offer.telefon}\n` +
      `💻 *İşlemci:* ${offer.islemci || '-'}\n` +
      `🎮 *Ekran Kartı:* ${offer.ekran_karti || '-'}\n` +
      `⚡ *RAM / SSD:* ${offer.ram || '-'} / ${offer.ssd || '-'}\n` +
      `✨ *Kozmetik / Durum:* ${offer.kozmetik || '-'} / ${offer.kullanim_durumu || '-'}\n\n` +
      `💡 *Fiyat Vermek İçin:* Bu mesaja "Yanıtla (Reply)" yaparak vermek istediğiniz rakamı yazın (Örn: 18500).`;

    if (sock && connectionStatus === 'CONNECTED') {
      const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      await sock.sendMessage(myJid, { text: adminNotification });
      console.log(`✓ Yeni teklif bildirimi WhatsApp sohbetine (${myJid}) gönderildi!`);
      return res.json({ success: true, message: 'Bildirim WhatsApp sohbetine iletildi.' });
    } else {
      console.log('⚠️ Bot WhatsApp oturumu henüz aktif olmadığı için bildirim gönderilemedi.');
      return res.status(503).json({ error: 'WhatsApp botu henüz bağlı değil' });
    }
  } catch (error) {
    console.error('❌ /send-offer Hata:', error);
    return res.status(500).json({ error: error.message });
  }
});

// 3. Oturumu Kapatma Endpoint'i
app.post('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      connectionStatus = 'OFFLINE';
      currentQr = null;
    }
    res.json({ success: true, message: 'Oturum kapatıldı' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Bot servisi ${PORT} portunda çalışıyor.`);
  connectToWhatsApp();
});