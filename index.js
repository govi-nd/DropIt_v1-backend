import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { nanoid } from "nanoid";
import { createClient } from "@supabase/supabase-js";

// Supabase Client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

const BUCKET_NAME = "dropIt";
// Signed URL valid for 10 years (effectively permanent)
const TEN_YEARS_IN_SECONDS = 10 * 365 * 24 * 60 * 60;

// Express App
const app = express();
app.use(cors());
app.use(express.json());

// Multer RAM storage cap (100MB)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
});

// Health check
app.get("/", (req, res) => {
    res.json({ status: "DropIt backend running" });
});

// POST /upload — upload a single file
app.post("/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "No file uploaded" });
        }

        const batchId = nanoid(8);
        const fileId = nanoid(8);
        const storagePath = `${batchId}/${fileId}-${req.file.originalname}`;

        const { error: storageError } = await supabase.storage
            .from(BUCKET_NAME)
            .upload(storagePath, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: false,
            });

        if (storageError) {
            return res.status(500).json({ success: false, message: `Storage error: ${storageError.message}` });
        }

        const fileRecord = {
            id: fileId,
            storage_path: storagePath,
            original_name: req.file.originalname,
            mime_type: req.file.mimetype,
            batch_id: batchId,
        };

        const { error: dbError } = await supabase.from("files").insert([fileRecord]);
        if (dbError) {
            await supabase.storage.from(BUCKET_NAME).remove([storagePath]);
            return res.status(500).json({ success: false, message: dbError.message });
        }

        const { data: signed, error: signError } = await supabase.storage
            .from(BUCKET_NAME)
            .createSignedUrl(storagePath, TEN_YEARS_IN_SECONDS, {
                download: req.file.originalname
            });

        res.json({
            success: true,
            message: "File uploaded successfully",
            batchId,
            fileId,
            downloadUrl: signError ? null : signed.signedUrl,
            fileName: req.file.originalname,
            fileCount: 1,
        });
    } catch (err) {
        console.error("Single upload failed:", err.message);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
});

// POST /upload-batch — upload multiple files grouped under batchId
app.post("/upload-batch", upload.array("files", 20), async (req, res) => {
    try {
        if (!req.files?.length) {
            return res.status(400).json({ success: false, message: "No files uploaded" });
        }

        const batchId = nanoid(8);

        const uploadResults = await Promise.allSettled(
            req.files.map(async (file) => {
                const fileId = nanoid(8);
                const storagePath = `${batchId}/${fileId}-${file.originalname}`;

                const { error } = await supabase.storage
                    .from(BUCKET_NAME)
                    .upload(storagePath, file.buffer, {
                        contentType: file.mimetype,
                        upsert: false,
                    });

                if (error) throw new Error(error.message);

                return {
                    id: fileId,
                    storage_path: storagePath,
                    original_name: file.originalname,
                    mime_type: file.mimetype,
                    batch_id: batchId,
                };
            })
        );

        const succeeded = uploadResults
            .filter((r) => r.status === "fulfilled")
            .map((r) => r.value);
        const failedCount = uploadResults.filter((r) => r.status === "rejected").length;

        if (!succeeded.length) {
            const firstError = uploadResults.find((r) => r.status === "rejected")?.reason?.message;
            return res.status(500).json({
                success: false,
                message: firstError ? `Storage error: ${firstError}` : "All file uploads failed",
            });
        }

        const { error: dbError } = await supabase.from("files").insert(succeeded);
        if (dbError) {
            await supabase.storage
                .from(BUCKET_NAME)
                .remove(succeeded.map((f) => f.storage_path));
            return res.status(500).json({ success: false, message: dbError.message });
        }

        res.json({
            success: true,
            message: `Uploaded ${succeeded.length} file(s) successfully`,
            batchId,
            fileCount: succeeded.length,
            failedCount,
        });
    } catch (err) {
        console.error("Batch upload failed:", err.message);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
});

// GET /batch/:batchId — fetch files for batch with signed download URLs
app.get("/batch/:batchId", async (req, res) => {
    try {
        const { batchId } = req.params;

        const { data: files, error: fetchError } = await supabase
            .from("files")
            .select("id, original_name, mime_type, storage_path")
            .eq("batch_id", batchId)
            .order("original_name", { ascending: true });

        if (fetchError) {
            return res.status(500).json({ success: false, message: fetchError.message });
        }
        if (!files?.length) {
            return res.status(404).json({ success: false, message: "Batch not found" });
        }

        const filesWithUrls = await Promise.all(
            files.map(async (file) => {
                const { data: signed, error: signError } = await supabase.storage
                    .from(BUCKET_NAME)
                    .createSignedUrl(file.storage_path, TEN_YEARS_IN_SECONDS);

                return {
                    id: file.id,
                    name: file.original_name,
                    mimeType: file.mime_type,
                    downloadUrl: signError ? null : signed.signedUrl,
                };
            })
        );

        res.json({
            success: true,
            batchId,
            fileCount: filesWithUrls.length,
            files: filesWithUrls,
        });
    } catch (err) {
        console.error("Batch fetch failed:", err.message);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
});

// Server listener (Vercel compatible)
if (!process.env.VERCEL) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 DropIt backend running on http://localhost:${PORT}`);
    });
}

// export default app;

