import express from 'express'
import cors from 'cors'
import { supabase } from './config/supabase.js'

const app = express()

app.use(cors())
app.use(express.json())

app.get('/', (req, res) => { res.send('API Absensi Amaga Corp jalan 🚀') })

// ==========================================
// 1. ENDPOINT LOGIN
// ==========================================
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body
  try {
    const { data: user, error } = await supabase.from('users').select('*, cabang(nama)').eq('nik', username).single()
    if (error || !user) return res.status(401).json({ message: 'Username tidak ditemukan' })
    if (user.password !== password) return res.status(401).json({ message: 'Password salah' })

    res.status(200).json({
      message: 'Login Berhasil',
      user: { id: user.id, nama: user.nama, role: user.role, nik: user.nik, cabang: user.cabang?.nama || 'Pusat', jabatan: user.jabatan, divisi: user.divisi }
    })
  } catch (err) { res.status(500).json({ message: 'Terjadi kesalahan pada server' }) }
})

// ==========================================
// 2. ENDPOINT CABANG & KARYAWAN
// ==========================================
app.get('/api/cabang', async (req, res) => {
  try {
    const { data, error } = await supabase.from('cabang').select('*').order('id', { ascending: true })
    if (error) throw error; res.status(200).json(data)
  } catch (err) { res.status(500).json({ message: 'Gagal mengambil data cabang' }) }
})

app.post('/api/cabang', async (req, res) => {
  try {
    const { data, error } = await supabase.from('cabang').insert([req.body])
    if (error) throw error; res.status(201).json({ message: 'Cabang berhasil ditambahkan', data })
  } catch (err) { res.status(500).json({ message: 'Gagal menambah cabang' }) }
})

app.put('/api/cabang/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('cabang').update(req.body).eq('id', req.params.id)
    if (error) throw error; res.status(200).json({ message: 'Cabang berhasil diupdate', data })
  } catch (err) { res.status(500).json({ message: 'Gagal mengupdate cabang' }) }
})

app.put('/api/cabang/:id/status', async (req, res) => {
  try {
    const { error } = await supabase.from('cabang').update({ is_active: req.body.is_active }).eq('id', req.params.id)
    if (error) throw error; res.status(200).json({ message: 'Status berhasil diubah' })
  } catch (err) { res.status(500).json({ message: 'Gagal mengubah status' }) }
})

app.get('/api/karyawan', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*, cabang(nama)').order('nama', { ascending: true })
    if (error) throw error; res.status(200).json(data)
  } catch (err) { res.status(500).json({ message: 'Gagal mengambil data karyawan' }) }
})

app.post('/api/karyawan', async (req, res) => {
  try {
    const { error } = await supabase.from('users').insert([req.body])
    if (error) throw error; res.status(201).json({ message: 'Karyawan berhasil ditambahkan' })
  } catch (err) { res.status(500).json({ message: 'Gagal menambah karyawan' }) }
})

// ==========================================
// 3. ENDPOINT ABSENSI & RIWAYAT KARYAWAN
// ==========================================
app.post('/api/absensi', async (req, res) => {
  const { user_id, tipe_absen, waktu } = req.body;
  const today = new Date().toISOString().split('T')[0]; 
  try {
    const { data: existing } = await supabase.from('absensi').select('*').eq('user_id', user_id).eq('tanggal', today).single();

    if (tipe_absen === 'Masuk') {
      if (existing && existing.waktu_masuk) return res.status(400).json({ message: 'Anda sudah absen masuk hari ini' });
      const { error } = await supabase.from('absensi').insert([{ user_id, tanggal: today, waktu_masuk: waktu, status_kehadiran: 'Hadir' }]);
      if (error) throw error; return res.status(200).json({ message: 'Absen Masuk Berhasil!' });
    }
    if (tipe_absen === 'Pulang') {
      if (!existing) return res.status(400).json({ message: 'Belum absen masuk hari ini' });
      if (existing.waktu_pulang) return res.status(400).json({ message: 'Sudah absen pulang hari ini' });
      const { error } = await supabase.from('absensi').update({ waktu_pulang: waktu }).eq('id', existing.id);
      if (error) throw error; return res.status(200).json({ message: 'Absen Pulang Berhasil!' });
    }
    if (tipe_absen === 'Istirahat') {
      if (!existing) return res.status(400).json({ message: 'Belum absen masuk hari ini' });
      const { error } = await supabase.from('absensi').update({ waktu_istirahat_mulai: waktu }).eq('id', existing.id);
      if (error) throw error; return res.status(200).json({ message: 'Absen Istirahat Mulai dicatat!' });
    }
  } catch (err) { res.status(500).json({ message: 'Terjadi kesalahan sistem' }); }
})

app.get('/api/riwayat/:user_id', async (req, res) => {
  try {
    const { data: absensi } = await supabase.from('absensi').select('*').eq('user_id', req.params.user_id).order('tanggal', { ascending: false });
    const { data: perizinan } = await supabase.from('perizinan').select('*').eq('user_id', req.params.user_id).order('created_at', { ascending: false });
    res.status(200).json({ absensi, perizinan });
  } catch (err) { res.status(500).json({ message: 'Gagal mengambil riwayat' }); }
});

// ==========================================
// 4. ENDPOINT PERIZINAN & APPROVAL (BARU)
// ==========================================
app.post('/api/perizinan', async (req, res) => {
  try {
    const { error } = await supabase.from('perizinan').insert([req.body]);
    if (error) throw error; res.status(201).json({ message: 'Pengajuan berhasil dikirim dan menunggu persetujuan.' });
  } catch (err) { res.status(500).json({ message: 'Gagal mengirim pengajuan' }); }
});

app.delete('/api/perizinan/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('perizinan').delete().eq('id', req.params.id);
    if (error) throw error; res.status(200).json({ message: 'Data perizinan berhasil dihapus' });
  } catch (err) { res.status(500).json({ message: 'Gagal menghapus data' }); }
});

// GET SEMUA PERIZINAN UNTUK HRD
app.get('/api/perizinan/all', async (req, res) => {
  try {
    // Join dengan tabel users untuk mendapat nama, jabatan, dll
    const { data, error } = await supabase
      .from('perizinan')
      .select(`
        *,
        users ( nama, jabatan, divisi, no_telp, cabang (nama) )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ message: 'Gagal mengambil data perizinan' });
  }
});

// UPDATE STATUS APPROVAL (SETUJUI / TOLAK)
app.put('/api/perizinan/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status_approval } = req.body;
  try {
    const { error } = await supabase
      .from('perizinan')
      .update({ status_approval })
      .eq('id', id);
      
    if (error) throw error;
    res.status(200).json({ message: `Status berhasil diubah menjadi ${status_approval}` });
  } catch (err) {
    res.status(500).json({ message: 'Gagal mengubah status' });
  }
});

const PORT = process.env.PORT || 3000
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`) })