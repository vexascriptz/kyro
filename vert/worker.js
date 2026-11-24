// The video engine. It runs in its own thread, so the page stays responsive,
// and it keeps working while the page sits in a background tab on a computer.
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  canEncodeAudio,
  canEncodeVideo,
  Conversion,
  ConversionCanceledError,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
} from 'https://cdn.jsdelivr.net/npm/mediabunny@1.66.0/dist/bundles/mediabunny.min.mjs';

let current = null;          // the conversion running in this worker, if any
let cancelRequested = false; // lets a job that is still starting up stop too

self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'probe') probe(msg);
  else if (msg.type === 'convert') convert(msg);
  else if (msg.type === 'cancel') {
    cancelRequested = true;
    if (current) current.cancel();
  }
};

// Reads the basic facts about a file without converting it.
async function probe({ id, file }) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video found.');
    const [width, height, duration, decodable] = await Promise.all([
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      input.computeDuration(),
      track.canDecode(),
    ]);
    self.postMessage({ type: 'probed', id, info: { width, height, duration, decodable } });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: 'This file couldn’t be read as a video.' });
  } finally {
    input.dispose();
  }
}

// Stretches the whole frame to width × (width × 16/9) and writes the result.
async function convert({ id, file, width, quality }) {
  cancelRequested = false;
  let input = null;
  try {
    const height = Math.round((width * 16) / 9);
    const videoQuality = new Quality(quality);

    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

    // MP4 (H.264 + AAC) is what Photos and most apps expect. Fall back to WebM
    // when this browser can't make H.264, or when the sound would need an AAC
    // encoder that isn't available here (otherwise the sound would be dropped).
    const audioTrack = await input.getPrimaryAudioTrack();
    const audioIsAac = audioTrack ? (await audioTrack.getCodec()) === 'aac' : true;
    const useMp4 =
      (await canEncodeVideo('avc', { width, height, quality: videoQuality })) &&
      (audioIsAac || (await canEncodeAudio('aac')));

    const target = new BufferTarget();
    const output = new Output({
      format: useMp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
      target,
    });

    const conversion = await Conversion.init({
      input,
      output,
      video: {
        width,
        height,
        fit: 'fill', // stretch to fill the 9:16 frame: no cropping, no black bars
        codec: useMp4 ? 'avc' : 'vp9',
        quality: videoQuality,
      },
      audio: { codec: useMp4 ? 'aac' : 'opus' },
    });

    if (!conversion.isValid) throw new Error('This browser can’t decode this video’s format.');
    if (cancelRequested) throw new ConversionCanceledError();

    current = conversion;
    conversion.onProgress = (value) => self.postMessage({ type: 'progress', id, value });
    await conversion.execute();

    const buffer = target.buffer;
    const audioDropped = conversion.discardedTracks.some((d) => d.track.isAudioTrack());
    self.postMessage(
      { type: 'done', id, buffer, mimeType: useMp4 ? 'video/mp4' : 'video/webm', audioDropped },
      [buffer],
    );
  } catch (err) {
    if (err instanceof ConversionCanceledError) {
      self.postMessage({ type: 'cancelled', id });
    } else {
      self.postMessage({ type: 'error', id, message: err?.message || 'Conversion failed.' });
    }
  } finally {
    current = null;
    input?.dispose();
  }
}
