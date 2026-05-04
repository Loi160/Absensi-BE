import express from "express";
import cors from "cors";
import "dotenv/config";
import cron from "node-cron";
import crypto from "crypto";
import { supabase } from "./config/supabase.js";

const app = express();
app.use(cors());
app.use(express.json());

const requireRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const userId = req.headers["x-user-id"];
      const sessionToken = req.headers["x-session-token"];

      if (!userId || !sessionToken) {
        return res
          .status(401)
          .json({ message: "Akses ditolak. User belum login." });
      }

      const { data: user, error } = await supabase
        .from("users")
        .select("id, nama, role, cabang_id, status, session_token")
        .eq("id", userId)
        .single();

      if (error || !user) {
        return res.status(401).json({ message: "User tidak valid." });
      }

      if (!user.session_token || sessionToken !== user.session_token) {
        return res
          .status(401)
          .json({ message: "Session tidak valid. Silakan login ulang." });
      }

      if (user.status === "Nonaktif") {
        return res.status(403).json({ message: "Akun sudah nonaktif." });
      }

      if (!allowedRoles.includes(user.role)) {
        return res
          .status(403)
          .json({ message: "Akses ditolak. Role tidak diizinkan." });
      }

      req.user = user;
      next();
    } catch (err) {
      return res.status(500).json({
        message: "Gagal validasi akses.",
        detail: err.message,
      });
    }
  };
};

const getIndonesianTime = (offsetDays = 0) => {
  const currentDate = new Date();
  const utcTimestamp =
    currentDate.getTime() + currentDate.getTimezoneOffset() * 60000;
  const wibTime = new Date(utcTimestamp + 3600000 * 7);

  if (offsetDays !== 0) {
    wibTime.setDate(wibTime.getDate() + offsetDays);
  }

  const year = wibTime.getFullYear();
  const month = String(wibTime.getMonth() + 1).padStart(2, "0");
  const day = String(wibTime.getDate()).padStart(2, "0");

  return {
    dateString: `${year}-${month}-${day}`,
    dayOfWeek: wibTime.getDay(),
    dateObject: wibTime,
  };
};

const calculateMinutesDifference = (startTime, endTime) => {
  if (!startTime || !endTime) return 0;
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  return endHour * 60 + endMinute - (startHour * 60 + startMinute);
};

const formatBranchPayload = (body) => {
  const payload = { ...body };

  ["keterlambatan", "parent_id", "radius_toleransi"].forEach((field) => {
    if (payload[field]) payload[field] = parseInt(payload[field], 10);
  });

  [
    "jam_masuk_weekday",
    "jam_keluar_weekday",
    "jam_masuk_weekend",
    "jam_keluar_weekend",
    "jam_mulai_lembur",
    "jam_selesai_lembur",
  ].forEach((field) => {
    if (payload[field] && payload[field].length === 5) {
      payload[field] = `${payload[field]}:00`;
    }
  });

  return payload;
};

const sanitizeUserPayload = (body) => {
  const payload = { ...body };
  delete payload.id;
  delete payload.cabang;
  delete payload.session_token;

  payload.tanggal_masuk = payload.tanggal_masuk || null;
  payload.tanggal_lahir = payload.tanggal_lahir || null;

  if (payload.cabang_id) {
    const parsedId = parseInt(payload.cabang_id, 10);
    payload.cabang_id = isNaN(parsedId) ? null : parsedId;
  } else {
    payload.cabang_id = null;
  }

  return payload;
};

const cleanupOldAttendancePhotos = async () => {
  const { dateObject: todayObj } = getIndonesianTime();
  const cutoffDate = new Date(todayObj);
  cutoffDate.setDate(cutoffDate.getDate() - 30);
  const cutoffStr = cutoffDate.toISOString().split("T")[0];

  const { data: staleAttendance, error: fetchErr } = await supabase
    .from("absensi")
    .select("id, foto_masuk, foto_pulang")
    .lt("tanggal", cutoffStr)
    .or("foto_masuk.not.is.null,foto_pulang.not.is.null");

  if (fetchErr) throw fetchErr;

  if (!staleAttendance?.length) {
    return { message: "Tidak ada foto usang yang perlu dihapus." };
  }

  const filesToDelete = [];

  staleAttendance.forEach((record) => {
    [record.foto_masuk, record.foto_pulang].forEach((url) => {
      if (url && !url.includes("Telah Dihapus")) {
        filesToDelete.push(url.split("/").pop());
      }
    });
  });

  if (filesToDelete.length > 0) {
    const { error: rmErr } = await supabase.storage
      .from("foto_absensi")
      .remove(filesToDelete);

    if (rmErr) console.error("Gagal hapus fisik foto:", rmErr);
  }

  for (const record of staleAttendance) {
    const updatePayload = {};

    if (record.foto_masuk && !record.foto_masuk.includes("Telah Dihapus")) {
      updatePayload.foto_masuk = "Telah Dihapus Otomatis (Lebih dari 30 Hari)";
    }

    if (record.foto_pulang && !record.foto_pulang.includes("Telah Dihapus")) {
      updatePayload.foto_pulang = "Telah Dihapus Otomatis (Lebih dari 30 Hari)";
    }

    if (Object.keys(updatePayload).length > 0) {
      await supabase.from("absensi").update(updatePayload).eq("id", record.id);
    }
  }

  return {
    message: `Berhasil membersihkan foto usang dari ${staleAttendance.length} data absensi.`,
  };
};

app.get("/", (req, res) => {
  res.send("API Absensi Amaga Corp jalan");
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("*, cabang(*)")
      .eq("nik", username)
      .single();

    if (error || !user) {
      return res.status(401).json({ message: "Username tidak ditemukan" });
    }

    if (user.password !== password) {
      return res.status(401).json({ message: "Password salah" });
    }

    if (user.status === "Nonaktif") {
      return res.status(403).json({
        message: "Akun Anda telah dinonaktifkan. Hubungi HRD.",
      });
    }

    const sessionToken = crypto.randomBytes(32).toString("hex");

    const { error: updateSessionError } = await supabase
      .from("users")
      .update({ session_token: sessionToken })
      .eq("id", user.id);

    if (updateSessionError) {
      return res.status(500).json({ message: "Gagal membuat session login." });
    }

    let subBranchNames = [];

    if (user.role === "managerCabang" && user.cabang_id) {
      const { data: subBranches } = await supabase
        .from("cabang")
        .select("nama")
        .eq("parent_id", user.cabang_id);

      if (subBranches) {
        subBranchNames = subBranches.map((branch) => branch.nama);
      }
    }

    return res.status(200).json({
      message: "Login Berhasil",
      session_token: sessionToken,
      user: {
        id: user.id,
        nama: user.nama,
        role: user.role,
        nik: user.nik,
        foto_karyawan: user.foto_karyawan,
        cabang_id: user.cabang_id,
        cabangUtama: user.cabang?.nama || "Pusat",
        titik_koordinat: user.cabang?.titik_koordinat || null,
        radius_toleransi: user.cabang?.radius_toleransi || 20,
        subCabang: subBranchNames,
        jabatan: user.jabatan,
        divisi: user.divisi,
      },
    });
  } catch (err) {
    return res
      .status(500)
      .json({ message: "Server Error", detail: err.message });
  }
});

app.get(
  "/api/cabang",
  requireRole("hrd", "managerCabang"),
  async (req, res) => {
    const { data, error } = await supabase
      .from("cabang")
      .select("*")
      .order("id", { ascending: true });

    if (error) {
      return res
        .status(500)
        .json({ message: "Gagal mengambil cabang", detail: error.message });
    }

    res.status(200).json(data || []);
  },
);

app.post("/api/cabang", requireRole("hrd"), async (req, res) => {
  try {
    const payload = formatBranchPayload(req.body);
    const { error } = await supabase.from("cabang").insert([payload]);

    if (error) {
      return res
        .status(400)
        .json({ message: "Gagal menambah cabang", detail: error.message });
    }

    res.status(201).json({ message: "Cabang berhasil ditambahkan" });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Gagal menambah cabang", error: err.message });
  }
});

app.put("/api/cabang/:id", requireRole("hrd"), async (req, res) => {
  try {
    const payload = formatBranchPayload(req.body);

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

app.put("/api/cabang/:id/status", requireRole("hrd"), async (req, res) => {
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

app.get(
  "/api/karyawan",
  requireRole("hrd", "managerCabang"),
  async (req, res) => {
    let selectFields =
      "id, nik, nama, role, jabatan, divisi, tempat_lahir, tanggal_lahir, jenis_kelamin, tanggal_masuk, status, alamat, no_telp, cabang_id, foto_karyawan, ktp, kk, skck, sim, sertifikat, dokumen_tambahan, cabang(nama)";

    if (req.user.role === "hrd") {
      selectFields =
        "id, nik, password, nama, role, jabatan, divisi, tempat_lahir, tanggal_lahir, jenis_kelamin, tanggal_masuk, status, alamat, no_telp, cabang_id, foto_karyawan, ktp, kk, skck, sim, sertifikat, dokumen_tambahan, cabang(nama)";
    }

    let query = supabase
      .from("users")
      .select(selectFields)
      .order("nama", { ascending: true });

    if (req.user.role === "managerCabang") {
      const { data: subBranches, error: subBranchError } = await supabase
        .from("cabang")
        .select("id")
        .eq("parent_id", req.user.cabang_id);

      if (subBranchError) {
        return res.status(500).json({
          message: "Gagal mengambil sub-cabang",
          detail: subBranchError.message,
        });
      }

      const allowedCabangIds = [
        req.user.cabang_id,
        ...(subBranches || []).map((branch) => branch.id),
      ];

      query = query.in("cabang_id", allowedCabangIds);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({
        message: "Gagal mengambil data karyawan",
        detail: error.message,
      });
    }

    res.status(200).json(data || []);
  },
);

app.post("/api/karyawan", requireRole("hrd"), async (req, res) => {
  try {
    const payload = sanitizeUserPayload(req.body);
    const { error } = await supabase.from("users").insert([payload]);

    if (error) {
      return res
        .status(400)
        .json({ message: "Gagal menambah data", detail: error.message });
    }

    res.status(201).json({ message: "Karyawan berhasil ditambahkan" });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Gagal menambah karyawan", detail: err.message });
  }
});

app.put("/api/karyawan/:id", requireRole("hrd"), async (req, res) => {
  try {
    const payload = sanitizeUserPayload(req.body);

    const { error } = await supabase
      .from("users")
      .update(payload)
      .eq("id", req.params.id);

    if (error) {
      return res
        .status(400)
        .json({ message: "Gagal mengubah data", detail: error.message });
    }

    res.status(200).json({ message: "Data berhasil diubah" });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Gagal mengubah data", detail: err.message });
  }
});

app.put("/api/karyawan/:id/status", requireRole("hrd"), async (req, res) => {
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

app.post(
  "/api/absensi",
  requireRole("karyawan", "managerCabang", "hrd"),
  async (req, res) => {
    const {
      user_id,
      tipe_absen,
      waktu,
      foto,
      waktu_istirahat_mulai,
      waktu_istirahat_selesai,
    } = req.body;

    let targetUserId = req.user.id;

    if (req.user.role === "hrd" && user_id) {
      targetUserId = user_id;
    }

    const { dateString: today, dayOfWeek } = getIndonesianTime();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    try {
      const { data: user } = await supabase
        .from("users")
        .select("cabang_id")
        .eq("id", targetUserId)
        .single();

      const { data: branch } = await supabase
        .from("cabang")
        .select("*")
        .eq("id", user.cabang_id)
        .single();

      const { data: existingAttendance } = await supabase
        .from("absensi")
        .select("*")
        .eq("user_id", targetUserId)
        .eq("tanggal", today)
        .single();

      if (tipe_absen === "Masuk") {
        if (existingAttendance?.waktu_masuk) {
          return res
            .status(400)
            .json({ message: "Anda sudah melakukan Absen Masuk hari ini." });
        }

        let minutesLate = 0;

        if (branch) {
          const targetTime = isWeekend
            ? branch.jam_masuk_weekend
            : branch.jam_masuk_weekday;
          const tolerance = branch.keterlambatan || 0;
          const diff = calculateMinutesDifference(targetTime, waktu);
          if (diff > tolerance) minutesLate = diff;
        }

        const { error } = await supabase.from("absensi").insert([
          {
            user_id: targetUserId,
            tanggal: today,
            waktu_masuk: waktu,
            foto_masuk: foto,
            status_kehadiran: "Hadir",
            menit_terlambat: minutesLate,
          },
        ]);

        if (error) throw error;
      } else if (tipe_absen === "Istirahat") {
        if (!existingAttendance) {
          return res
            .status(400)
            .json({ message: "Anda belum Absen Masuk hari ini." });
        }

        if (existingAttendance.waktu_istirahat_mulai) {
          return res
            .status(400)
            .json({ message: "Jadwal istirahat sudah diatur sebelumnya." });
        }

        const { error } = await supabase
          .from("absensi")
          .update({ waktu_istirahat_mulai, waktu_istirahat_selesai })
          .eq("id", existingAttendance.id);

        if (error) throw error;
      } else if (tipe_absen === "Pulang") {
        if (!existingAttendance?.waktu_masuk) {
          return res
            .status(400)
            .json({ message: "Anda belum Absen Masuk hari ini." });
        }

        if (existingAttendance.waktu_pulang) {
          return res
            .status(400)
            .json({ message: "Anda sudah Absen Pulang hari ini." });
        }

        let overtimeMinutes = 0;

        if (branch) {
          if (!existingAttendance.waktu_istirahat_mulai) overtimeMinutes += 180;

          const overtimeStart = branch.jam_mulai_lembur || "18:00:00";
          const overtimeEnd = branch.jam_selesai_lembur || "20:00:00";
          const overtimeDiff = calculateMinutesDifference(overtimeStart, waktu);

          if (overtimeDiff > 0) {
            const maxOvertime = calculateMinutesDifference(
              overtimeStart,
              overtimeEnd,
            );
            overtimeMinutes +=
              overtimeDiff >= maxOvertime ? maxOvertime : overtimeDiff;
          }
        }

        const { error } = await supabase
          .from("absensi")
          .update({
            waktu_pulang: waktu,
            foto_pulang: foto,
            menit_lembur: overtimeMinutes,
          })
          .eq("id", existingAttendance.id);

        if (error) throw error;
      } else {
        return res.status(400).json({ message: "Tipe absen tidak valid." });
      }

      res
        .status(200)
        .json({ message: `Absen ${tipe_absen} berhasil dicatat!` });
    } catch (error) {
      res
        .status(500)
        .json({ message: "Gagal memproses absensi.", detail: error.message });
    }
  },
);

app.post("/api/absensi/manual", requireRole("hrd"), async (req, res) => {
  const { user_id, tanggal, waktu_masuk, waktu_pulang, keterangan } = req.body;

  try {
    let minutesLate = 0;
    let overtimeMinutes = 0;

    const { data: user } = await supabase
      .from("users")
      .select("cabang_id")
      .eq("id", user_id)
      .single();

    const { data: branch } = await supabase
      .from("cabang")
      .select("*")
      .eq("id", user?.cabang_id)
      .single();

    if (branch && waktu_masuk) {
      const date = new Date(tanggal);
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      const targetTime = isWeekend
        ? branch.jam_masuk_weekend
        : branch.jam_masuk_weekday;
      const diff = calculateMinutesDifference(targetTime, waktu_masuk);
      if (diff > (branch.keterlambatan || 0)) minutesLate = diff;
    }

    if (branch && waktu_pulang) {
      const overtimeStart = branch.jam_mulai_lembur || "18:00:00";
      const overtimeEnd = branch.jam_selesai_lembur || "20:00:00";
      const overtimeDiff = calculateMinutesDifference(
        overtimeStart,
        waktu_pulang,
      );

      if (overtimeDiff > 0) {
        const maxOvertime = calculateMinutesDifference(
          overtimeStart,
          overtimeEnd,
        );
        overtimeMinutes =
          overtimeDiff >= maxOvertime ? maxOvertime : overtimeDiff;
      }
    }

    const { data: existingAttendance } = await supabase
      .from("absensi")
      .select("*")
      .eq("user_id", user_id)
      .eq("tanggal", tanggal)
      .single();

    if (existingAttendance) {
      await supabase
        .from("absensi")
        .update({
          waktu_masuk: waktu_masuk || existingAttendance.waktu_masuk,
          waktu_pulang: waktu_pulang || existingAttendance.waktu_pulang,
          is_manual_masuk: true,
          keterangan_manual: keterangan,
          menit_terlambat: waktu_masuk
            ? minutesLate
            : existingAttendance.menit_terlambat,
          menit_lembur: waktu_pulang
            ? overtimeMinutes
            : existingAttendance.menit_lembur,
        })
        .eq("id", existingAttendance.id);
    } else {
      await supabase.from("absensi").insert([
        {
          user_id,
          tanggal,
          waktu_masuk,
          waktu_pulang,
          status_kehadiran: "Hadir",
          is_manual_masuk: true,
          keterangan_manual: keterangan,
          menit_terlambat: minutesLate,
          menit_lembur: overtimeMinutes,
        },
      ]);
    }

    res.status(200).json({ message: "Absensi manual berhasil disimpan" });
  } catch (err) {
    res.status(500).json({ message: "Gagal menyimpan absensi manual" });
  }
});

app.get(
  "/api/riwayat/:user_id",
  requireRole("karyawan", "managerCabang", "hrd"),
  async (req, res) => {
    const userId = req.params.user_id;

    try {
      if (req.user.role === "karyawan" && userId !== req.user.id) {
        return res
          .status(403)
          .json({ message: "Tidak boleh melihat riwayat orang lain." });
      }

      if (req.user.role === "managerCabang") {
  const { data: subBranches, error: subBranchError } = await supabase
    .from("cabang")
    .select("id")
    .eq("parent_id", req.user.cabang_id);

  if (subBranchError) {
    return res.status(500).json({
      message: "Gagal mengambil sub-cabang",
      detail: subBranchError.message,
    });
  }

  const allowedCabangIds = [
    req.user.cabang_id,
    ...(subBranches || []).map((branch) => branch.id),
  ];

  const { data: targetUser } = await supabase
    .from("users")
    .select("cabang_id")
    .eq("id", userId)
    .single();

  if (!targetUser || !allowedCabangIds.includes(targetUser.cabang_id)) {
    return res.status(403).json({
      message: "Manager tidak boleh melihat riwayat cabang lain.",
    });
  }
}

      const { data: user } = await supabase
        .from("users")
        .select("id, cabang_id, cabang(nama)")
        .eq("id", userId)
        .single();

      const { data: attendanceList } = await supabase
        .from("absensi")
        .select("*")
        .eq("user_id", userId)
        .order("tanggal", { ascending: false });

      const { data: permissionList } = await supabase
        .from("perizinan")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      const { dateObject: todayObj, dateString: todayStr } =
        getIndonesianTime();
      const startDate = new Date(todayObj);
      startDate.setDate(todayObj.getDate() - 30);

      const syntheticAlpha = [];
      const isPusat =
        user?.cabang?.nama?.toLowerCase().includes("amaga") ||
        user?.cabang?.nama?.toLowerCase().includes("pusat") ||
        !user?.cabang_id;

      for (let i = 0; i <= 30; i++) {
        const currentDate = new Date(startDate);
        currentDate.setDate(currentDate.getDate() + i);

        const dateKey = currentDate.toISOString().split("T")[0];
        const dayOfWeek = currentDate.getDay();

        if (dateKey >= todayStr) break;
        if (isPusat && dayOfWeek === 0) continue;

        const hasAttendance = (attendanceList || []).some(
          (record) => record.tanggal === dateKey,
        );
        const hasPermission = (permissionList || []).some(
          (perm) =>
            perm.status_approval === "Disetujui" &&
            dateKey >= perm.tanggal_mulai &&
            dateKey <= perm.tanggal_selesai,
        );

        if (!hasAttendance && !hasPermission) {
          syntheticAlpha.push({
            id: `alpha_${dateKey}`,
            user_id: userId,
            tanggal: dateKey,
            waktu_masuk: null,
            waktu_pulang: null,
            status_kehadiran: "ALPHA",
            is_alpha: true,
          });
        }
      }

      res.status(200).json({
        absensi: [...(attendanceList || []), ...syntheticAlpha],
        perizinan: permissionList || [],
      });
    } catch (err) {
      res.status(500).json({ message: "Gagal mengambil riwayat" });
    }
  },
);

app.post(
  "/api/perizinan",
  requireRole("karyawan", "managerCabang", "hrd"),
  async (req, res) => {
    try {
      const body = { ...req.body };

      const payload = {
        user_id:
          req.user.role === "hrd" && body.user_id
            ? body.user_id
            : req.user.id,

        kategori: body.kategori,
        jenis_izin: body.jenis_izin || null,
        tanggal_mulai: body.tanggal_mulai || null,
        tanggal_selesai: body.tanggal_selesai || body.tanggal_mulai || null,
        jam_mulai: body.jam_mulai || null,
        jam_selesai: body.jam_selesai || null,
        keperluan: body.keperluan || null,
        kendaraan: body.kendaraan || null,
        keterangan: body.keterangan || null,
        bukti_foto: body.bukti_foto || null,
        status_approval: "Pending",
      };

      if (!["Izin", "Cuti", "FIMTK"].includes(payload.kategori)) {
        return res.status(400).json({
          message: "Kategori perizinan tidak valid.",
          detail: `Kategori diterima: ${payload.kategori}`,
        });
      }

      if (!payload.tanggal_mulai || !payload.tanggal_selesai) {
        return res.status(400).json({
          message: "Tanggal mulai dan tanggal selesai wajib diisi.",
        });
      }

      const { error } = await supabase.from("perizinan").insert([payload]);

      if (error) {
        return res.status(400).json({
          message: "Gagal mengirim pengajuan.",
          detail: error.message,
        });
      }

      return res.status(201).json({
        message: "Pengajuan berhasil dikirim.",
      });
    } catch (err) {
      return res.status(500).json({
        message: "Gagal mengirim pengajuan.",
        detail: err.message,
      });
    }
  },
);

app.get("/api/perizinan/all", requireRole("hrd"), async (req, res) => {
  const { data, error } = await supabase
    .from("perizinan")
    .select(
      "*, users(id, nama, nik, role, jabatan, divisi, no_telp, cabang_id, cabang(nama))",
    )
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(500).json({
      message: "Gagal mengambil perizinan",
      detail: error.message,
    });
  }

  res.status(200).json(data || []);
});

app.put(
  "/api/perizinan/:id/status",
  requireRole("hrd", "managerCabang"),
  async (req, res) => {
    try {
      const { status_approval } = req.body;

      if (!["Pending", "Disetujui", "Ditolak"].includes(status_approval)) {
        return res.status(400).json({
          message: "Status approval tidak valid.",
          detail: `Status diterima: ${status_approval}`,
        });
      }

      const { data: izin, error: izinError } = await supabase
        .from("perizinan")
        .select("id, user_id, status_approval")
        .eq("id", req.params.id)
        .single();

      if (izinError || !izin) {
        return res.status(404).json({
          message: "Data perizinan tidak ditemukan.",
          detail: izinError?.message,
        });
      }

      const { data: pemohon, error: pemohonError } = await supabase
        .from("users")
        .select("id, cabang_id")
        .eq("id", izin.user_id)
        .single();

      if (pemohonError || !pemohon) {
        return res.status(404).json({
          message: "Data pemohon perizinan tidak ditemukan.",
          detail: pemohonError?.message,
        });
      }

      if (req.user.role === "managerCabang") {
        const { data: subBranches, error: subBranchError } = await supabase
          .from("cabang")
          .select("id")
          .eq("parent_id", req.user.cabang_id);

        if (subBranchError) {
          return res.status(500).json({
            message: "Gagal mengambil sub-cabang.",
            detail: subBranchError.message,
          });
        }

        const allowedCabangIds = [
          req.user.cabang_id,
          ...(subBranches || []).map((branch) => branch.id),
        ];

        if (!allowedCabangIds.includes(pemohon.cabang_id)) {
          return res.status(403).json({
            message: "Manager tidak boleh memproses perizinan cabang lain.",
          });
        }
      }

      const { error: updateError } = await supabase
        .from("perizinan")
        .update({ status_approval })
        .eq("id", req.params.id);

      if (updateError) {
        return res.status(400).json({
          message: "Gagal mengubah status perizinan.",
          detail: updateError.message,
        });
      }

      return res.status(200).json({
        message: `Perizinan berhasil di-${status_approval}.`,
      });
    } catch (err) {
      return res.status(500).json({
        message: "Gagal mengubah status perizinan.",
        detail: err.message,
      });
    }
  },
);

app.get(
  "/api/manager/perizinan/:cabang_id",
  requireRole("managerCabang", "hrd"),
  async (req, res) => {
    const cabangParam = Number(req.params.cabang_id);

    try {
      if (req.user.role === "managerCabang") {
        const { data: subBranches, error: subBranchError } = await supabase
          .from("cabang")
          .select("id")
          .eq("parent_id", req.user.cabang_id);

        if (subBranchError) {
          return res.status(500).json({
            message: "Gagal mengambil sub-cabang",
            detail: subBranchError.message,
          });
        }

        const allowedCabangIds = [
          req.user.cabang_id,
          ...(subBranches || []).map((branch) => branch.id),
        ];

        if (!allowedCabangIds.includes(cabangParam)) {
          return res.status(403).json({
            message: "Manager tidak boleh akses perizinan cabang lain.",
          });
        }
      }

      const { data, error } = await supabase
        .from("perizinan")
        .select(
          "*, users!inner(id, nama, nik, role, jabatan, divisi, cabang_id, cabang(nama))",
        )
        .eq("users.cabang_id", cabangParam)
        .order("created_at", { ascending: false });

      if (error) {
        return res.status(500).json({
          message: "Gagal mengambil perizinan",
          detail: error.message,
        });
      }

      return res.status(200).json(data || []);
    } catch (err) {
      return res.status(500).json({
        message: "Gagal mengambil perizinan",
        detail: err.message,
      });
    }
  },
);

app.get(
  "/api/laporan",
  requireRole("hrd", "managerCabang"),
  async (req, res) => {
    const { start_date, end_date } = req.query;
    const { dateObject: todayObj, dateString: todayStr } = getIndonesianTime();

    let startStr = start_date;
    let endStr = end_date;

    if (!startStr || !endStr) {
      const year = todayObj.getFullYear();
      const month = todayObj.getMonth();
      const date = todayObj.getDate();

      let start;
      let end;

      if (date <= 25) {
        start = new Date(year, month - 1, 26);
        end = new Date(year, month, 25);
      } else {
        start = new Date(year, month, 26);
        end = new Date(year, month + 1, 25);
      }

      const format = (dt) => {
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, "0");
        const d = String(dt.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      };

      startStr = startStr || format(start);
      endStr = endStr || format(end);
    }

    const dateList = [];
    const runner = new Date(startStr);
    let stopDate = new Date(endStr);

    if (stopDate > todayObj) stopDate = todayObj;

    while (runner <= stopDate) {
      dateList.push({
        dateStr: runner.toISOString().split("T")[0],
        dayOfWeek: runner.getDay(),
      });
      runner.setDate(runner.getDate() + 1);
    }

    try {
      let userQuery = supabase
  .from("users")
  .select("id, nama, nik, jabatan, divisi, no_telp, cabang_id, cabang(*)");

      if (req.user.role === "managerCabang") {
  const { data: subBranches, error: subBranchError } = await supabase
    .from("cabang")
    .select("id")
    .eq("parent_id", req.user.cabang_id);

  if (subBranchError) {
    return res.status(500).json({
      message: "Gagal mengambil sub-cabang",
      detail: subBranchError.message,
    });
  }

  const allowedCabangIds = [
    req.user.cabang_id,
    ...(subBranches || []).map((branch) => branch.id),
  ];

  userQuery = userQuery.in("cabang_id", allowedCabangIds);
}

      const { data: users, error: userError } = await userQuery;
      if (userError) throw userError;

      const userIds = (users || []).map((user) => user.id);

      const { data: attendanceData } = await supabase
  .from("absensi")
  .select("*")
  .in("user_id", userIds)
  .gte("tanggal", startStr)
  .lte("tanggal", endStr);

const { data: permissionData } = await supabase
  .from("perizinan")
  .select("*")
  .in("user_id", userIds)
  .eq("status_approval", "Disetujui")
  .lte("tanggal_mulai", endStr)
  .gte("tanggal_selesai", startStr);

      const report = (users || []).map((user) => {
        const isPusat =
          user.cabang?.nama?.toLowerCase().includes("amaga") ||
          user.cabang?.nama?.toLowerCase().includes("pusat") ||
          !user.cabang_id;

        const userAttendance = (attendanceData || []).filter(
          (a) =>
            a.user_id === user.id &&
            a.tanggal >= startStr &&
            a.tanggal <= endStr,
        );

        const userPermissions = (permissionData || []).filter(
          (p) =>
            p.user_id === user.id &&
            p.tanggal_selesai >= startStr &&
            p.tanggal_mulai <= endStr,
        );

        userAttendance.forEach((record) => {
          if (!record.menit_terlambat && user.cabang && record.waktu_masuk) {
            const d = new Date(record.tanggal);
            const isWeekend = d.getDay() === 0 || d.getDay() === 6;
            const target = isWeekend
              ? user.cabang.jam_masuk_weekend
              : user.cabang.jam_masuk_weekday;
            const tolerance = user.cabang.keterlambatan || 0;
            const diff = calculateMinutesDifference(target, record.waktu_masuk);
            if (diff > tolerance) record.menit_terlambat = diff;
          }
        });

        const lateCount = userAttendance.filter(
          (a) => a.menit_terlambat > 0,
        ).length;
        const totalOvertimeMinutes = userAttendance.reduce(
          (sum, a) => sum + (a.menit_lembur || 0),
          0,
        );
        const totalOvertimeHours = Math.floor(totalOvertimeMinutes / 60);

        let alphaCount = 0;
        const alphaDates = [];

        dateList.forEach((d) => {
          if (d.dateStr >= todayStr) return;
          if (isPusat && d.dayOfWeek === 0) return;

          const hasAttendance = userAttendance.some(
            (a) => a.tanggal === d.dateStr,
          );
          const hasPermission = userPermissions.some(
            (p) =>
              d.dateStr >= p.tanggal_mulai && d.dateStr <= p.tanggal_selesai,
          );

          if (!hasAttendance && !hasPermission) {
            alphaCount++;
            alphaDates.push({
              tanggal: d.dateStr,
              keterangan: "Tanpa Keterangan",
            });
          }
        });

        return {
  id: user.id,
  nama: user.nama,
  nik: user.nik,
  jabatan: user.jabatan || "-",
  divisi: user.divisi || "-",
  noTelp: user.no_telp || "-",
  cabang: user.cabang?.nama || "-",
          hadirApp: userAttendance
            .filter((a) => !a.is_manual_masuk)
            .length.toString(),
          hadirManual: userAttendance
            .filter((a) => a.is_manual_masuk)
            .length.toString(),
          izin: userPermissions
            .filter((p) => p.kategori === "Izin" && p.jenis_izin !== "Sakit")
            .length.toString(),
          sakit: userPermissions
            .filter((p) => p.kategori === "Izin" && p.jenis_izin === "Sakit")
            .length.toString(),
          cuti: userPermissions
            .filter((p) => p.kategori === "Cuti")
            .length.toString(),
          terlambat: lateCount.toString(),
          fimtk: userPermissions
            .filter((p) => p.kategori === "FIMTK")
            .length.toString(),
          lembur: `${totalOvertimeHours} Jam`,
          alpha: alphaCount.toString(),
          rawAbsensi: userAttendance,
          rawPerizinan: userPermissions,
          rawAlpha: alphaDates,
        };
      });

      res.status(200).json(report);
    } catch (err) {
      res
        .status(500)
        .json({ message: "Gagal mengambil laporan", detail: err.message });
    }
  },
);

app.get(
  "/api/dashboard/stats",
  requireRole("hrd", "managerCabang"),
  async (req, res) => {
    const { sub_cabang } = req.query;

    try {
      let userQuery = supabase
        .from("users")
        .select("id, cabang_id, cabang(nama)");

      if (req.user.role === "managerCabang") {
  const { data: subBranches, error: subBranchError } = await supabase
    .from("cabang")
    .select("id")
    .eq("parent_id", req.user.cabang_id);

  if (subBranchError) {
    return res.status(500).json({
      message: "Gagal mengambil sub-cabang",
      detail: subBranchError.message,
    });
  }

  const allowedCabangIds = [
    req.user.cabang_id,
    ...(subBranches || []).map((branch) => branch.id),
  ];

  userQuery = userQuery.in("cabang_id", allowedCabangIds);
} else if (
  req.user.role === "hrd" &&
  sub_cabang &&
  sub_cabang !== "Semua Cabang"
) {
  userQuery = userQuery.eq("cabang.nama", sub_cabang);
}

      const { data: allUsers, error: userError } = await userQuery;
      if (userError) throw userError;

      const users =
        sub_cabang && !["Semua Cabang", "Semua Sub-Cabang"].includes(sub_cabang)
          ? (allUsers || []).filter((u) => u.cabang?.nama === sub_cabang)
          : allUsers || [];

      const userIds = users.map((u) => u.id);

      if (userIds.length === 0) {
        return res.status(200).json({
          totals: {
            hadir: 0,
            sakit: 0,
            izin: 0,
            cuti: 0,
            terlambat: 0,
            alpha: 0,
          },
          chart: {
            hadir: Array(7).fill(0),
            sakit: Array(7).fill(0),
            izin: Array(7).fill(0),
            cuti: Array(7).fill(0),
            terlambat: Array(7).fill(0),
            alpha: Array(7).fill(0),
          },
        });
      }

      const { dateString: todayStr } = getIndonesianTime();
      const { dateString: sixDaysAgoStr, dateObject: spanDaysAgo } =
        getIndonesianTime(-6);

      const { data: attendanceRecords } = await supabase
        .from("absensi")
        .select("*")
        .in("user_id", userIds)
        .gte("tanggal", sixDaysAgoStr);

      const { data: approvedPermissions } = await supabase
        .from("perizinan")
        .select("*")
        .in("user_id", userIds)
        .eq("status_approval", "Disetujui");

      const chart = {
        hadir: Array(7).fill(0),
        sakit: Array(7).fill(0),
        izin: Array(7).fill(0),
        cuti: Array(7).fill(0),
        terlambat: Array(7).fill(0),
        alpha: Array(7).fill(0),
      };

      let alphaCounter = 0;

      for (let i = 0; i <= 6; i++) {
        const runner = new Date(spanDaysAgo);
        runner.setDate(runner.getDate() + i);

        const dateKey = runner.toISOString().split("T")[0];
        const dayIndex = runner.getDay();
        const chartIndex = dayIndex === 0 ? 6 : dayIndex - 1;

        if (dateKey >= todayStr) break;

        users.forEach((user) => {
          const isPusat =
            user.cabang?.nama?.toLowerCase().includes("amaga") ||
            user.cabang?.nama?.toLowerCase().includes("pusat");

          if (isPusat && dayIndex === 0) return;

          const hasAttendance = (attendanceRecords || []).some(
            (a) => a.user_id === user.id && a.tanggal === dateKey,
          );

          const hasPermission = (approvedPermissions || []).some(
            (p) =>
              p.user_id === user.id &&
              dateKey >= p.tanggal_mulai &&
              dateKey <= p.tanggal_selesai,
          );

          if (!hasAttendance && !hasPermission) {
            alphaCounter++;
            chart.alpha[chartIndex] += 1;
          }
        });
      }

      (attendanceRecords || []).forEach((record) => {
        const user = users.find((u) => u.id === record.user_id);

        if (!record.menit_terlambat && user?.cabang && record.waktu_masuk) {
          const d = new Date(record.tanggal);
          const isWeekend = d.getDay() === 0 || d.getDay() === 6;
          const target = isWeekend
            ? user.cabang.jam_masuk_weekend
            : user.cabang.jam_masuk_weekday;
          const diff = calculateMinutesDifference(target, record.waktu_masuk);

          if (diff > (user.cabang.keterlambatan || 0)) {
            record.menit_terlambat = diff;
          }
        }

        const dayIdx = new Date(record.tanggal).getDay();
        const chartIdx = dayIdx === 0 ? 6 : dayIdx - 1;

        chart.hadir[chartIdx] += 1;
        if (record.menit_terlambat > 0) chart.terlambat[chartIdx] += 1;
      });

      const totals = {
        hadir: (attendanceRecords || []).length,
        sakit: (approvedPermissions || []).filter(
          (p) => p.kategori === "Izin" && p.jenis_izin === "Sakit",
        ).length,
        izin: (approvedPermissions || []).filter(
          (p) => p.kategori === "Izin" && p.jenis_izin !== "Sakit",
        ).length,
        cuti: (approvedPermissions || []).filter((p) => p.kategori === "Cuti")
          .length,
        terlambat: (attendanceRecords || []).filter(
          (a) => a.menit_terlambat > 0,
        ).length,
        alpha: alphaCounter,
      };

      res.status(200).json({ totals, chart });
    } catch (err) {
      res
        .status(500)
        .json({ message: "Gagal mengambil statistik", detail: err.message });
    }
  },
);

app.delete("/api/cleanup-fotos", requireRole("hrd"), async (req, res) => {
  try {
    const result = await cleanupOldAttendancePhotos();
    res.status(200).json(result);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Gagal membersihkan foto", detail: err.message });
  }
});

cron.schedule(
  "0 0 * * *",
  async () => {
    try {
      const result = await cleanupOldAttendancePhotos();
      console.log("Cron Job Success:", result.message);
    } catch (err) {
      console.error("Cron Job Failed:", err.message);
    }
  },
  {
    scheduled: true,
    timezone: "Asia/Jakarta",
  },
);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
