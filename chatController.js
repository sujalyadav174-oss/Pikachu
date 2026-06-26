'use strict';

const path = require('path');
const logger = require('../utils/logger');
const { safeParseJson } = require('../utils/jsonRepair');
const { transcribeAndRespond } = require('../services/geminiService');
const { generateSpeech } = require('../services/ttsService');
const { deleteFile, scheduleAudioDeletion } = require('../utils/fileCleanup');

/**
 * POST /api/chat
 *
 * Workflow:
 *  1. Validate that a WAV file was uploaded
 *  2. Send audio to Gemini
 *  3. Parse Gemini's JSON response (with auto-repair)
 *  4. Generate TTS speech for the reply text
 *  5. Schedule audio deletion in 5 minutes
 *  6. Delete uploaded microphone file immediately
 *  7. Return structured JSON response
 */
async function handleChat(req, res) {
  const uploadedFile = req.file;

  // ── 1. Validate upload ───────────────────────────────────────────────────
  if (!uploadedFile) {
    return res.status(400).json({
      success: false,
      error: 'No audio file uploaded. POST multipart/form-data with field name "audio".',
    });
  }

  const uploadedFilePath = uploadedFile.path;
  logger.info('Chat request received', {
    originalname: uploadedFile.originalname,
    size: uploadedFile.size,
    mimetype: uploadedFile.mimetype,
    savedAs: path.basename(uploadedFilePath),
  });

  try {
    // ── 2. Send to Gemini ──────────────────────────────────────────────────
    let rawGeminiResponse;
    try {
      rawGeminiResponse = await transcribeAndRespond(uploadedFilePath);
    } catch (err) {
      logger.error('Gemini request failed', { error: err.message });
      // Still delete the upload before bailing
      await deleteFile(uploadedFilePath);
      return res.status(502).json({
        success: false,
        error: 'AI service failed to process audio. Please try again.',
      });
    }

    // ── 3. Parse JSON ──────────────────────────────────────────────────────
    const pikachuData = safeParseJson(rawGeminiResponse);

    logger.info('Pikachu response parsed', {
      emotion: pikachuData.emotion,
      animation: pikachuData.animation,
      replySnippet: pikachuData.reply.slice(0, 60),
    });

    // ── 4. Generate TTS ────────────────────────────────────────────────────
    let audioResult;
    try {
      audioResult = await generateSpeech(pikachuData.reply);
    } catch (err) {
      logger.error('TTS generation failed', { error: err.message });
      // TTS failure is non-fatal — respond without audio URL
      await deleteFile(uploadedFilePath);
      return res.status(207).json({
        success: true,
        reply: pikachuData.reply,
        emotion: pikachuData.emotion,
        animation: pikachuData.animation,
        action: pikachuData.action,
        audio: null,
        warning: 'Speech synthesis failed. Text response available.',
      });
    }

    // ── 5. Schedule audio deletion ─────────────────────────────────────────
    scheduleAudioDeletion(audioResult.filePath);

    // ── 6. Delete uploaded microphone file ─────────────────────────────────
    await deleteFile(uploadedFilePath);

    // ── 7. Return response ─────────────────────────────────────────────────
    logger.info('Chat response sent', { audioUrl: audioResult.audioUrl });

    return res.status(200).json({
      success: true,
      reply: pikachuData.reply,
      emotion: pikachuData.emotion,
      animation: pikachuData.animation,
      action: pikachuData.action,
      audio: audioResult.audioUrl,
    });
  } catch (err) {
    // Catch-all — ensure upload is always cleaned up
    logger.error('Unexpected error in handleChat', { error: err.message, stack: err.stack });
    await deleteFile(uploadedFilePath).catch(() => {});
    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred. Please try again.',
    });
  }
}

module.exports = { handleChat };
