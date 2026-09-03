const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Supabase Yapılandırması
const SUPABASE_URL = 'https://mvqkljryofiaaxbocsqq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12cWtsanJ5b2ZpYWF4Ym9jc3FxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDAxMjE2MzQsImV4cCI6MjA1NTY5NzYzNH0.MzM1YTVmOTc1MDZkYmViM2UxNzY4ZjRhOWI5MjEwMDQ'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let sock = null;
let qrCodeData = null;
let connectionStatus = 'CONNECTING'; // CONNECTING | CONNECTED | DISCONNECTED
let userJid = null;

async function connectToWhatsApp() {
  connectionStatus = 'CONNECTING';
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["Laptop Express Bot", "Chrome", "1.0.0"]
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'CONNECTING';
      qrCodeData = await QRCode.toDataURL(qr);
      console.log('⚡ Yeni QR Kod Üretildi!');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      connectionStatus = 'DISCONNECTED';
      qrCodeData = null;
      console.log('Bağlantı kapandı, yeniden bağlanılıyor...', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      connectionStatus = 'CONNECTED';
      qrCodeData = null;
      userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      console.log('✓ WhatsApp Bağlantısı Başarılı!');
    }
  });

  sock.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      for (const msg of chatUpdate.messages) {
        if (!msg || !msg.message) continue;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          '';

        const contextInfo =
          msg.message.extendedTextMessage?.contextInfo ||
          msg.message.conversation?.contextInfo;

        const quotedMsg = contextInfo?.quotedMessage;

        if (quotedMsg && text) {
          const cleanPrice = text.trim().replace(/\./g, '').replace(/,/g, '').replace(/\s/g, '');

          if (!isNaN(cleanPrice) && cleanPrice.length > 0) {
            let quotedText = 
              quotedMsg.conversation ||
              quotedMsg.extendedTextMessage?.text ||
              quotedMsg.imageMessage?.caption ||
              '';

            const fullQuotedString = quotedText || JSON.stringify(quotedMsg);
            const match = fullQuotedString.match(/#(\d+)/);

            if (match) {
              const offerId = match[1];
              const offerPrice = cleanPrice;

              console.log(`🎯 #${offerId} teklif için yanıt yakalandı. Girilen Fiyat: ${offerPrice} TL`);

              // 1. Supabase Güncelle
              let offer = null;
              try {
                const { data, error } = await supabase
                  .from('teklifler')
                  .update({ fiyat: offerPrice, status: 'tamamlandi' })
                  .eq('id', offerId)
                  .select()
                  .single();

                if (error) {
                  console.log('✕ Supabase Güncelleme Hatası:', error.message);
                  return;
                }
                offer = data;
              } catch (dbErr) {
                console.log('✕ Supabase İstek Hatası:', dbErr.message);
                return;
              }

              if (offer) {
                console.log('✓ Supabase veritabanı başarıyla güncellendi!');
                
                let cleanPhone = offer.telefon.replace(/\D/g, '');
                if (cleanPhone.startsWith('0')) {
                  cleanPhone = cleanPhone.substring(1);
                }
                if (!cleanPhone.startsWith('90')) {
                  cleanPhone = '90' + cleanPhone;
                }

                const targetJid = `${cleanPhone}@s.whatsapp.net`;
                console.log(`📡 Mesaj Gönderilecek Hedef JID: ${targetJid}`);

                const customerMessage = `Merhaba Sayın *${offer.musteri_adi}*,\n\nLaptop Express üzerinden ilettiğiniz cihaz teklif talebiniz uzman ekibimizce değerlendirilmiştir.\n\n💻 *Cihaz Bilgileri:* ${offer.islemci} / ${offer.ekran_karti}\n💰 *Firmamızın Değerleme Teklifi:* *${offerPrice} TL*\n\nTeklifi onaylıyorsanız mağazamıza gelebilir veya yerinde ödeme talebinde bulunabilirsiniz.`;

                // 2. Müşterinin WhatsApp'ına Mesajı Gönder
                try {
                  await sock.sendMessage(targetJid, { text: customerMessage });
                  console.log(`✓ Müşteriye (${targetJid}) teklif mesajı başarıyla iletildi!`);
                } catch (sendErr) {
                  console.log(`✕ Müşteriye (${targetJid}) mesaj atılırken HATA oluştu:`, sendErr.message || sendErr);
                }

                // 3. Admin Sohbetine Onay Mesajı Düş
                try {
                  const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                  await sock.sendMessage(myJid, {
                    text: `✅ *#${offerId}* numaralı teklif (*${offerPrice} TL*) müşteriye (*${offer.musteri_adi}* - ${offer.telefon}) başarıyla iletildi.`,
                  });
                  console.log(`✓ Admin onay mesajı kendi sohbetine gönderildi.`);
                } catch (adminErr) {
                  console.log(`✕ Admin onay mesajı gönderilemedi:`, adminErr.message || adminErr);
                }
              }
            } else {
              console.log('⚠️ Alıntılanan mesajda #ID bulunamadı.');
            }
          }
        }
      }
    } catch (err) {
      console.log('✕ Message Upsert Hatası:', err);
    }
  });
}

// GÖRSEL QR KOD SAYFASI
app.get('/qr', (req, res) => {
  if (connectionStatus === 'CONNECTED') {
    return res.send('<h1 style="font-family:sans-serif; text-align:center; margin-top:50px; color:green;">✅ WhatsApp Botu Zaten Bağlı ve Aktif!</h1>');
  }
  if (!qrCodeData) {
    return res.send('<h1 style="font-family:sans-serif; text-align:center; margin-top:50px; color:orange;">⏳ QR Kod Oluşturuluyor, lütfen 5 saniye sonra sayfayı yenileyin...</h1>');
  }
  res.send(`
    <html>
      <head><title>Laptop Express Bot QR</title></head>
      <body style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:sans-serif; background:#0f172a; color:white;">
        <h2>📱 WhatsApp Botunu Bağlamak İçin QR Kodu Taratın</h2>
        <img src="${qrCodeData}" style="width:300px; height:300px; border:10px solid white; border-radius:12px; margin:20px 0;" />
        <p style="color:#94a3b8;">Telefonunuzdan WhatsApp -> Bağlı Cihazlar -> Cihaz Bağla yapın.</p>
      </body>
    </html>
  `);
});

app.get('/status', (req, res) => {
  res.json({ status: connectionStatus, qr: qrCodeData, user: userJid });
});

app.post('/new-offer', async (req, res) => {
  const offer = req.body;
  console.log('📩 Yeni teklif formu tetiklendi:', offer.musteri_adi, offer.telefon);

  if (connectionStatus === 'CONNECTED' && sock) {
    const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    
    const notifyText = `📩 *Yeni Teklif Talebi (#${offer.id})*\n\n👤 *Müşteri:* ${offer.musteri_adi} (${offer.telefon})\n💻 *İşlemci:* ${offer.islemci}\n🎮 *GPU:* ${offer.ekran_karti}\n🧠 *RAM/SSD:* ${offer.ram} / ${offer.ssd}\n✨ *Kozmetik:* ${offer.kozmetik || 'Belirtilmedi'}\n\n💡 *Bu mesaja yanıt (reply) vererek sadece fiyat yazın (Örn: 18500).*`;
    
    try {
      await sock.sendMessage(myJid, { text: notifyText });
      console.log('✓ Bildirim kendi sohbetine gönderildi!');
    } catch (err) {
      console.log('✕ Mesaj gönderim hatası:', err);
    }
  } else {
    console.log('⚠️ Bot bağlı değil veya hazır değil!');
  }
  res.json({ received: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Bot servisi ${PORT} portunda çalışıyor.`);
  connectToWhatsApp();
});