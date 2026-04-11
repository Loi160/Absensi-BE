import express from "express";
import cors from "cors";
import "dotenv/config";
import { supabase } from "./config/supabase.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("API Absensi Amaga Corp jalan 🚀");
});

// ==========================================
// FUNGSI PINTAR: KONVERSI KE WAKTU INDONESIA (WIB UTC+7)
// ==========================================
const getWaktuIndo = (offsetDays = 0) => {
  const d = new Date();
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const wib = new Date(utc + 3600000 * 7); // Konversi ke WIB

  if (offsetDays !== 0) {
    wib.setDate(wib.getDate() + offsetDays);
  }

  const yyyy = wib.getFullYear();
  const mm = String(wib.getMonth() + 1).padStart(2, "0");
  const dd = String(wib.getDate()).padStart(2, "0");

  return {
    tanggal: `${yyyy}-${mm}-${dd}`,
    hari: wib.getDay(), // 0 = Minggu
    obj: wib,
  };
};

// --- LOGIN ---
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("*, cabang(*)")
      .eq("nik", username)
      .single();
    if (error || !user)
      return res.status(401).json({ message: "Username tidak ditemukan" });
    if (user.password !== password)
      return res.status(401).json({ message: "Password salah" });

    if (user.status === "Nonaktif")
      return res
        .status(403)
        .json({ message: "Akun Anda telah dinonaktifkan. Hubungi HRD." });

    let subCabangNames = [];
    if (user.role === "managerCabang" && user.cabang_id) {
      const { data: subs } = await supabase
        .from("cabang")
        .select("nama")
        .eq("parent_id", user.cabang_id);
      if (subs) subCabangNames = subs.map((s) => s.nama);
    }

    res.status(200).json({
      message: "Login Berhasil",
      user: {
        id: user.id,
        nama: user.nama,
        role: user.role,
        nik: user.nik,
        cabang_id: user.cabang_id,
        cabangUtama: user.cabang?.nama || "Pusat",
        titik_koordinat: user.cabang?.titik_koordinat || null,
        radius_toleransi: user.cabang?.radius_toleransi || 20,
        subCabang: subCabangNames,
        jabatan: user.jabatan,
        divisi: user.divisi,
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Server Error" });
  }
});

// --- CABANG ---
app.get("/api/cabang", async (req, res) => {
  const { data } = await supabase
    .from("cabang")
    .select("*")
    .order("id", { ascending: true });
  res.status(200).json(data || []);
});

app.post("/api/cabang", async (req, res) => {
  try {
    let payload = { ...req.body };
    if (payload.keterlambatan)
      payload.keterlambatan = parseInt(payload.keterlambatan, 10);
    if (payload.parent_id) payload.parent_id = parseInt(payload.parent_id, 10);
    if (payload.radius_toleransi)
      payload.radius_toleransi = parseInt(payload.radius_toleransi, 10);

    const timeFields = [
      "jam_masuk_weekday",
      "jam_keluar_weekday",
      "jam_masuk_weekend",
      "jam_keluar_weekend",
      "jam_mulai_lembur",
      "jam_selesai_lembur",
    ];
    timeFields.forEach((field) => {
      if (payload[field] && payload[field].length === 5)
        payload[field] = `${payload[field]}:00`;
    });

    const { error } = await supabase.from("cabang").insert([payload]);
    if (error)
      return res
        .status(400)
        .json({ message: "Gagal menambah cabang", detail: error.message });
    res.status(201).json({ message: "Cabang berhasil ditambahkan" });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Gagal menambah cabang", error: err.message });
  }
});

app.put("/api/cabang/:id", async (req, res) => {
  try {
    let payload = { ...req.body };
    if (payload.keterlambatan)
      payload.keterlambatan = parseInt(payload.keterlambatan, 10);
    if (payload.parent_id) payload.parent_id = parseInt(payload.parent_id, 10);
    if (payload.radius_toleransi)
      payload.radius_toleransi = parseInt(payload.radius_toleransi, 10);

    const timeFields = [
      "jam_masuk_weekday",
      "jam_keluar_weekday",
      "jam_masuk_weekend",
      "jam_keluar_weekend",
      "jam_mulai_lembur",
      "jam_selesai_lembur",
    ];
    timeFields.forEach((field) => {
      if (payload[field] && payload[field].length === 5)
        payload[field] = `${payload[field]}:00`;
    });

    const { error } = await supabase
      .from("cabang")
      .update(payload)
      .eq("id", req.params.id);
    if (error) throw error;
    res.status(200).json({ message: "Data cabang berhasil diubah" });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Gagal mengubah cabang", error: err.message });
  }
});

app.put("/api/cabang/:id/status", async (req, res) => {
  try {
    const { is_active } = req.body;
    const { error } = await supabase
      .from("cabang")
      .update({ is_active })
      .eq("id", req.params.id);
    if (error) throw error;
    res.status(200).json({ message: "Status cabang berhasil diubah" });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Gagal mengubah status cabang", error: err.message });
  }
});

// --- PEMBERSIH DATA KARYAWAN ---
const cleanUserPayload = (body) => {
  let payload = { ...body };
  delete payload.id;
  delete payload.cabang;

  if (!payload.tanggal_masuk || payload.tanggal_masuk === "")
    payload.tanggal_masuk = null;
  if (!payload.tanggal_lahir || payload.tanggal_lahir === "")
    payload.tanggal_lahir = null;

  if (payload.cabang_id) {
    payload.cabang_id = parseInt(payload.cabang_id, 10);
    if (isNaN(payload.cabang_id)) payload.cabang_id = null;
  } else {
    payload.cabang_id = null;
  }
  return payload;
};

app.get("/api/karyawan", async (req, res) => {
  const { data } = await supabase
    .from("users")
    .select("*, cabang(nama)")
    .order("nama", { ascending: true });
  res.status(200).json(data || []);
});

app.post("/api/karyawan", async (req, res) => {
  try {
    const payload = cleanUserPayload(req.body);
    const { error } = await supabase.from("users").insert([payload]);
    if (error)
      return res
        .status(400)
        .json({ message: "Gagal menambah data", detail: error.message });
    res.status(201).json({ message: "Karyawan berhasil ditambahkan" });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Gagal menambah karyawan", detail: err.message });
  }
});

app.put("/api/karyawan/:id", async (req, res) => {
  try {
    const payload = cleanUserPayload(req.body);
    const { error } = await supabase
      .from("users")
      .update(payload)
      .eq("id", req.params.id);
    if (error)
      return res
        .status(400)
        .json({ message: "Gagal mengubah data", detail: error.message });
    res.status(200).json({ message: "Data berhasil diubah" });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Gagal mengubah data", detail: err.message });
  }
});

app.put("/api/karyawan/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const { error } = await supabase
      .from("users")
      .update({ status })
      .eq("id", req.params.id);
    if (error) throw error;
    res
      .status(200)
      .json({ message: `Status berhasil diubah menjadi ${status}` });
  } catch (err) {
    res.status(500).json({ message: "Gagal mengubah status karyawan" });
  }
});

// ==========================================
// --- LOGIKA KALKULASI ABSENSI & LEMBUR ---
// ==========================================
const hitungSelisihMenit = (waktuAwal, waktuAkhir) => {
  if (!waktuAwal || !waktuAkhir) return 0;
  const [h1, m1] = waktuAwal.split(":").map(Number);
  const [h2, m2] = waktuAkhir.split(":").map(Number);
  return h2 * 60 + m2 - (h1 * 60 + m1);
};

app.post("/api/absensi", async (req, res) => {
  const {
    user_id,
    tipe_absen,
    waktu,
    foto,
    waktu_istirahat_mulai,
    waktu_istirahat_selesai,
  } = req.body;

  const { tanggal: today, hari: dayOfWeek } = getWaktuIndo();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  try {
    const { data: user } = await supabase
      .from("users")
      .select("cabang_id")
      .eq("id", user_id)
      .single();
    const { data: cabang } = await supabase
      .from("cabang")
      .select("*")
      .eq("id", user.cabang_id)
      .single();

    const { data: existing } = await supabase
      .from("absensi")
      .select("*")
      .eq("user_id", user_id)
      .eq("tanggal", today)
      .single();

    if (tipe_absen === "Masuk") {
      if (existing && existing.waktu_masuk)
        return res
          .status(400)
          .json({ message: "Anda sudah melakukan Absen Masuk hari ini." });

      let menit_terlambat = 0;
      if (cabang) {
        const jamMasukTarget = isWeekend
          ? cabang.jam_masuk_weekend
          : cabang.jam_masuk_weekday;
        const batasToleransi = cabang.keterlambatan || 0;

        const selisihMsk = hitungSelisihMenit(jamMasukTarget, waktu);
        if (selisihMsk > batasToleransi) {
          menit_terlambat = selisihMsk;
        }
      }

      const { error } = await supabase.from("absensi").insert([
        {
          user_id,
          tanggal: today,
          waktu_masuk: waktu,
          foto_masuk: foto,
          status_kehadiran: "Hadir",
          menit_terlambat: menit_terlambat,
        },
      ]);
      if (error) throw error;
    } else if (tipe_absen === "Istirahat") {
      if (!existing)
        return res
          .status(400)
          .json({ message: "Anda belum Absen Masuk hari ini." });
      if (existing.waktu_istirahat_mulai)
        return res
          .status(400)
          .json({ message: "Jadwal istirahat sudah diatur sebelumnya." });

      const { error } = await supabase
        .from("absensi")
        .update({
          waktu_istirahat_mulai: waktu_istirahat_mulai,
          waktu_istirahat_selesai: waktu_istirahat_selesai,
        })
        .eq("id", existing.id);
      if (error) throw error;
    } else if (tipe_absen === "Pulang") {
      if (!existing || !existing.waktu_masuk)
        return res
          .status(400)
          .json({ message: "Anda belum Absen Masuk hari ini." });
      if (existing.waktu_pulang)
        return res
          .status(400)
          .json({ message: "Anda sudah Absen Pulang hari ini." });

      let menit_lembur = 0;
      if (cabang) {
        if (!existing.waktu_istirahat_mulai) {
          menit_lembur += 180;
        }

        const jamMulaiLembur = cabang.jam_mulai_lembur || "18:00:00";
        const jamBatasLembur = cabang.jam_selesai_lembur || "20:00:00";

        const cekLewatLembur = hitungSelisihMenit(jamMulaiLembur, waktu);

        if (cekLewatLembur > 0) {
          const durasiMaksLembur = hitungSelisihMenit(
            jamMulaiLembur,
            jamBatasLembur,
          );
          if (cekLewatLembur >= durasiMaksLembur) {
            menit_lembur += durasiMaksLembur;
          } else {
            menit_lembur += cekLewatLembur;
          }
        }
      }

      const { error } = await supabase
        .from("absensi")
        .update({
          waktu_pulang: waktu,
          foto_pulang: foto,
          menit_lembur: menit_lembur,
        })
        .eq("id", existing.id);
      if (error) throw error;
    }

    res.status(200).json({ message: `Absen ${tipe_absen} berhasil dicatat!` });
  } catch (error) {
    console.error("SUPABASE ERROR ABSENSI:", error);
    res
      .status(500)
      .json({ message: "Gagal memproses absensi.", detail: error.message });
  }
});

app.post("/api/absensi/manual", async (req, res) => {
  const { user_id, tanggal, waktu_masuk, waktu_pulang, keterangan } = req.body;
  try {
    const { data: existing } = await supabase
      .from("absensi")
      .select("*")
      .eq("user_id", user_id)
      .eq("tanggal", tanggal)
      .single();
    if (existing) {
      await supabase
        .from("absensi")
        .update({
          waktu_masuk: waktu_masuk || existing.waktu_masuk,
          waktu_pulang: waktu_pulang || existing.waktu_pulang,
          is_manual_masuk: true,
          keterangan_manual: keterangan,
        })
        .eq("id", existing.id);
    } else {
      await supabase
        .from("absensi")
        .insert([
          {
            user_id,
            tanggal,
            waktu_masuk,
            waktu_pulang,
            status_kehadiran: "Hadir",
            is_manual_masuk: true,
            keterangan_manual: keterangan,
          },
        ]);
    }
    res.status(200).json({ message: "Absensi manual berhasil disimpan" });
  } catch (err) {
    res.status(500).json({ message: "Gagal menyimpan absensi manual" });
  }
});

// ==========================================
// --- API RIWAYAT (DIPERBARUI UNTUK MEMUNCULKAN ALPHA) ---
// ==========================================
app.get("/api/riwayat/:user_id", async (req, res) => {
  const user_id = req.params.user_id;

  try {
    const { data: user } = await supabase.from("users").select("*, cabang(nama)").eq("id", user_id).single();
    const { data: absensi } = await supabase.from("absensi").select("*").eq("user_id", user_id).order("tanggal", { ascending: false });
    const { data: perizinan } = await supabase.from("perizinan").select("*").eq("user_id", user_id).order("created_at", { ascending: false });

    // Logika menyisipkan status Alpha untuk 30 hari ke belakang
    const { obj: todayObj, tanggal: todayStr } = getWaktuIndo();
    const startObj = new Date(todayObj);
    startObj.setDate(todayObj.getDate() - 30);
    
    let syntheticAlpha = [];
    const isPusat = user?.cabang?.nama?.toLowerCase().includes("amaga") || user?.cabang?.nama?.toLowerCase().includes("pusat") || !user?.cabang_id;

    for (let i = 0; i <= 30; i++) {
      let d = new Date(startObj);
      d.setDate(d.getDate() + i);
      let dStr = d.toISOString().split("T")[0];
      let dayOfWeek = d.getDay();

      if (dStr >= todayStr) break; // Jangan tampilkan Alpha untuk hari ini/besok
      if (isPusat && dayOfWeek === 0) continue; // Abaikan hari Minggu untuk pusat

      const adaAbsen = absensi.some((a) => a.tanggal === dStr);
      const adaIzin = perizinan.some((p) => p.status_approval === 'Disetujui' && dStr >= p.tanggal_mulai && dStr <= p.tanggal_selesai);

      if (!adaAbsen && !adaIzin) {
        syntheticAlpha.push({
          id: `alpha_${dStr}`,
          user_id: user_id,
          tanggal: dStr,
          waktu_masuk: null,
          waktu_pulang: null,
          status_kehadiran: "ALPHA",
          is_alpha: true 
        });
      }
    }

    const allAbsensi = [...(absensi || []), ...syntheticAlpha];
    res.status(200).json({ absensi: allAbsensi, perizinan: perizinan || [] });
  } catch (err) {
    res.status(500).json({ message: "Gagal mengambil riwayat" });
  }
});

app.post("/api/perizinan", async (req, res) => {
  await supabase.from("perizinan").insert([req.body]);
  res.status(201).json({ message: "Pengajuan berhasil dikirim." });
});

app.get("/api/perizinan/all", async (req, res) => {
  const { data } = await supabase
    .from("perizinan")
    .select("*, users (*, cabang(nama))")
    .order("created_at", { ascending: false });
  res.status(200).json(data || []);
});

app.put("/api/perizinan/:id/status", async (req, res) => {
  await supabase
    .from("perizinan")
    .update({ status_approval: req.body.status_approval })
    .eq("id", req.params.id);
  res.status(200).json({ message: "Berhasil" });
});

app.get("/api/manager/perizinan/:cabang_id", async (req, res) => {
  const { data } = await supabase
    .from("perizinan")
    .select("*, users!inner(*, cabang(nama))")
    .eq("users.cabang_id", req.params.cabang_id)
    .order("created_at", { ascending: false });
  res.status(200).json(data || []);
});

// ==========================================
// --- REKAPITULASI LAPORAN ---
// ==========================================
app.get("/api/laporan", async (req, res) => {
  const { role, cabang_id, start_date, end_date } = req.query;

  const { obj: todayObj, tanggal: todayStr } = getWaktuIndo();
  const endStr = end_date || todayStr;

  let startStr = start_date;
  if (!startStr) {
    startStr = getWaktuIndo(-30).tanggal;
  }

  let dateList = [];
  let currDate = new Date(startStr);
  let stopDate = new Date(endStr);
  if (stopDate > todayObj) stopDate = todayObj;

  while (currDate <= stopDate) {
    dateList.push({
      dateStr: currDate.toISOString().split("T")[0],
      dayOfWeek: currDate.getDay(), // 0 = Minggu
    });
    currDate.setDate(currDate.getDate() + 1);
  }

  try {
    let userQuery = supabase
      .from("users")
      .select("id, nama, nik, cabang_id, cabang(nama)");
    if (role === "managerCabang" && cabang_id)
      userQuery = userQuery.eq("cabang_id", cabang_id);

    const { data: users } = await userQuery;
    const { data: absensi } = await supabase.from("absensi").select("*");
    const { data: perizinan } = await supabase
      .from("perizinan")
      .select("*")
      .eq("status_approval", "Disetujui");

    const laporanRekap = users.map((user) => {
      const isPusat =
        user.cabang?.nama?.toLowerCase().includes("amaga") ||
        user.cabang?.nama?.toLowerCase().includes("pusat") ||
        !user.cabang_id;

      const userAbsen = absensi.filter(
        (a) =>
          a.user_id === user.id && a.tanggal >= startStr && a.tanggal <= endStr,
      );
      const userIzin = perizinan.filter(
        (p) =>
          p.user_id === user.id &&
          p.tanggal_selesai >= startStr &&
          p.tanggal_mulai <= endStr,
      );

      const totalKaliTerlambat = userAbsen.filter(
        (a) => a.menit_terlambat > 0,
      ).length;
      const totalMenitLembur = userAbsen.reduce(
        (sum, a) => sum + (a.menit_lembur || 0),
        0,
      );
      const totalJamLembur = Math.floor(totalMenitLembur / 60);

      let alphaCount = 0;
      let alphaDates = []; // Menyimpan detail tanggal Alpha

      dateList.forEach((d) => {
        if (d.dateStr >= todayStr) return;
        if (isPusat && d.dayOfWeek === 0) return; 

        const adaAbsen = userAbsen.some((a) => a.tanggal === d.dateStr);
        const adaIzin = userIzin.some(
          (p) => d.dateStr >= p.tanggal_mulai && d.dateStr <= p.tanggal_selesai,
        );

        if (!adaAbsen && !adaIzin) {
          alphaCount++;
          alphaDates.push({
            tanggal: d.dateStr,
            keterangan: "Tidak ada catatan absensi atau perizinan (Tanpa Keterangan)."
          });
        }
      });

      return {
        id: user.id,
        nama: user.nama,
        nik: user.nik,
        cabang: user.cabang?.nama || "-",
        hadirApp: userAbsen.filter((a) => !a.is_manual_masuk).length.toString(),
        hadirManual: userAbsen
          .filter((a) => a.is_manual_masuk)
          .length.toString(),
        izin: userIzin
          .filter((p) => p.kategori === "Izin" && p.jenis_izin !== "Sakit")
          .length.toString(),
        sakit: userIzin
          .filter((p) => p.kategori === "Izin" && p.jenis_izin === "Sakit")
          .length.toString(),
        cuti: userIzin.filter((p) => p.kategori === "Cuti").length.toString(),
        terlambat: totalKaliTerlambat.toString(),
        fimtk: userIzin.filter((p) => p.kategori === "FIMTK").length.toString(),
        lembur: `${totalJamLembur} Jam`,
        alpha: alphaCount.toString(),
        rawAbsensi: userAbsen,
        rawPerizinan: userIzin,
        rawAlpha: alphaDates // Mengirim array tanggal Alpha ke Frontend
      };
    });
    res.status(200).json(laporanRekap);
  } catch (err) {
    res.status(500).json({ message: "Gagal" });
  }
});

// ==========================================
// --- STATISTIK DASHBOARD ---
// ==========================================
app.get("/api/dashboard/stats", async (req, res) => {
  const { role, cabang_id } = req.query;
  try {
    let userQuery = supabase.from("users").select("id, cabang(nama)");
    if (role === "managerCabang" && cabang_id) {
      userQuery = userQuery.eq("cabang_id", cabang_id);
    }
    const { data: users } = await userQuery;
    const userIds = users.map((u) => u.id);

    const defaultResponse = {
      totals: { hadir: 0, sakit: 0, izin: 0, cuti: 0, terlambat: 0, alpha: 0 },
      chart: {
        hadir: [0, 0, 0, 0, 0, 0, 0],
        sakit: [0, 0, 0, 0, 0, 0, 0],
        izin: [0, 0, 0, 0, 0, 0, 0],
        cuti: [0, 0, 0, 0, 0, 0, 0],
        terlambat: [0, 0, 0, 0, 0, 0, 0],
        alpha: [0, 0, 0, 0, 0, 0, 0],
      },
    };

    if (userIds.length === 0) return res.status(200).json(defaultResponse);

    const { tanggal: todayStr, obj: todayObj } = getWaktuIndo();
    const { tanggal: sixDaysAgoStr, obj: spanDaysAgo } = getWaktuIndo(-6);

    const { data: absensi } = await supabase
      .from("absensi")
      .select("*")
      .in("user_id", userIds)
      .gte("tanggal", sixDaysAgoStr);
    const { data: perizinan } = await supabase
      .from("perizinan")
      .select("*")
      .in("user_id", userIds)
      .eq("status_approval", "Disetujui");

    const chart = {
      hadir: [0, 0, 0, 0, 0, 0, 0],
      sakit: [0, 0, 0, 0, 0, 0, 0],
      izin: [0, 0, 0, 0, 0, 0, 0],
      cuti: [0, 0, 0, 0, 0, 0, 0],
      terlambat: [0, 0, 0, 0, 0, 0, 0],
      alpha: [0, 0, 0, 0, 0, 0, 0],
    };
    let totalAlphaCounter = 0;

    for (let i = 0; i <= 6; i++) {
      let d = new Date(spanDaysAgo);
      d.setDate(d.getDate() + i);
      let dStr = d.toISOString().split("T")[0];
      let dayOfWeek = d.getDay();
      const adjustedIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

      if (dStr >= todayStr) break;

      users.forEach((user) => {
        const isPusat =
          user.cabang?.nama?.toLowerCase().includes("amaga") ||
          user.cabang?.nama?.toLowerCase().includes("pusat") ||
          !user.cabang_id;

        if (isPusat && dayOfWeek === 0) return;

        const adaAbsen = absensi.some(
          (a) => a.user_id === user.id && a.tanggal === dStr,
        );
        const adaIzin = perizinan.some(
          (p) =>
            p.user_id === user.id &&
            dStr >= p.tanggal_mulai &&
            dStr <= p.tanggal_selesai,
        );

        if (!adaAbsen && !adaIzin) {
          totalAlphaCounter++;
          chart.alpha[adjustedIndex] += 1;
        }
      });
    }

    absensi.forEach((ab) => {
      const dayIndex = new Date(ab.tanggal).getDay();
      const adjustedIndex = dayIndex === 0 ? 6 : dayIndex - 1;

      chart.hadir[adjustedIndex] += 1;
      if (ab.menit_terlambat > 0) chart.terlambat[adjustedIndex] += 1;
    });

    perizinan.forEach((pz) => {
      const dayIndex = new Date(pz.tanggal_mulai).getDay();
      const adjustedIndex = dayIndex === 0 ? 6 : dayIndex - 1;

      if (pz.kategori === "Izin" && pz.jenis_izin === "Sakit")
        chart.sakit[adjustedIndex] += 1;
      else if (pz.kategori === "Izin" && pz.jenis_izin !== "Sakit")
        chart.izin[adjustedIndex] += 1;
      else if (pz.kategori === "Cuti") chart.cuti[adjustedIndex] += 1;
    });

    const totals = {
      hadir: absensi.length,
      sakit: perizinan.filter(
        (p) => p.kategori === "Izin" && p.jenis_izin === "Sakit",
      ).length,
      izin: perizinan.filter(
        (p) => p.kategori === "Izin" && p.jenis_izin !== "Sakit",
      ).length,
      cuti: perizinan.filter((p) => p.kategori === "Cuti").length,
      terlambat: absensi.filter((a) => a.menit_terlambat > 0).length,
      alpha: totalAlphaCounter,
    };

    res.status(200).json({ totals, chart });
  } catch (err) {
    res.status(500).json({ message: "Gagal mengambil statistik" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});