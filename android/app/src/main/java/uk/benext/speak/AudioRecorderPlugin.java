package uk.benext.speak;

import android.media.MediaRecorder;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;

/**
 * 原生录音：绕过 WebView getUserMedia。
 *
 * 华为等机型上 WebView 的 getUserMedia 不可靠（系统权限已授予仍报
 * NotAllowedError），故用 Android MediaRecorder 直接录音。
 *
 * 格式：优先 WEBM/OPUS（API 29+），与现有 Web 端解码路径一致
 * （AudioContext.decodeAudioData 可解 WebM/Opus）；不支持时回落
 * MPEG_4/AAC（decodeAudioData 同样可解）。音频以 base64 返回给 JS，
 * JS 转成 Blob 后沿用现有 blobToPCM16k 流程。
 *
 * 权限：startRecording 前检查 RECORD_AUDIO；未授予则弹系统授权框，
 * 拒绝时 reject，JS 侧显示“无法录音，请允许麦克风权限。”
 */
@CapacitorPlugin(
    name = "AudioRecorder",
    permissions = @Permission(strings = {android.Manifest.permission.RECORD_AUDIO}, alias = "mic"))
public class AudioRecorderPlugin extends Plugin {

  private MediaRecorder recorder;
  private File outFile;
  private String outMime = "audio/webm";
  private boolean useWebm;
  private long startMs;

  @PluginMethod
  public void startRecording(PluginCall call) {
    if (recorder != null) {
      call.reject("already recording");
      return;
    }
    if (getPermissionState("mic") == PermissionState.GRANTED) {
      startInternal(call);
    } else {
      requestPermissionForAlias("mic", call, "onMicPermissionResult");
    }
  }

  @PermissionCallback
  private void onMicPermissionResult(PluginCall call) {
    if (getPermissionState("mic") == PermissionState.GRANTED) {
      startInternal(call);
    } else {
      call.reject("mic permission denied");
    }
  }

  private void startInternal(PluginCall call) {
    useWebm = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q; // API 29+ 支持 WEBM/OPUS
    try {
      startRecorder(useWebm);
      JSObject ret = new JSObject();
      ret.put("format", useWebm ? "webm/opus" : "mp4/aac");
      call.resolve(ret);
    } catch (Exception e) {
      releaseRecorder();
      if (useWebm) {
        // WEBM/OPUS 失败时回落到 MPEG_4/AAC 再试一次
        useWebm = false;
        try {
          startRecorder(false);
          JSObject ret = new JSObject();
          ret.put("format", "mp4/aac");
          call.resolve(ret);
          return;
        } catch (Exception e2) {
          releaseRecorder();
          call.reject("start recording failed: " + e2.getMessage());
          return;
        }
      }
      call.reject("start recording failed: " + e.getMessage());
    }
  }

  private void startRecorder(boolean webm) throws Exception {
    outFile = new File(getContext().getFilesDir(), webm ? "recording.webm" : "recording.m4a");
    if (outFile.exists()) outFile.delete();
    recorder =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            ? new MediaRecorder(getContext())
            : new MediaRecorder();
    recorder.setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION);
    // 语音识别专用源：比 MIC 少做失真处理（降噪/增益），Whisper 识别更准。
    // 显式 16kHz 单声道（Whisper 原生格式），免重采样；32kbps 足够语音。
    if (webm) {
      recorder.setOutputFormat(MediaRecorder.OutputFormat.WEBM);
      recorder.setAudioEncoder(MediaRecorder.AudioEncoder.OPUS);
      recorder.setAudioSamplingRate(16000);
      recorder.setAudioChannels(1);
      recorder.setAudioEncodingBitRate(32000);
      outMime = "audio/webm";
    } else {
      recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
      recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
      recorder.setAudioSamplingRate(16000);
      recorder.setAudioChannels(1);
      recorder.setAudioEncodingBitRate(32000);
      outMime = "audio/mp4";
    }
    recorder.setOutputFile(outFile.getAbsolutePath());
    recorder.prepare();
    recorder.start();
    startMs = System.currentTimeMillis();
  }

  @PluginMethod
  public void stopRecording(PluginCall call) {
    if (recorder == null) {
      call.reject("not recording");
      return;
    }
    try {
      recorder.stop();
    } catch (RuntimeException e) {
      // 录音太短 / 无数据时 stop 会抛异常，仍尝试读取已有文件
    } finally {
      releaseRecorder();
    }
    try {
      if (outFile == null || !outFile.exists() || outFile.length() == 0) {
        call.reject("recording empty, please hold longer");
        return;
      }
      byte[] data = readAll(outFile);
      outFile.delete();
      JSObject ret = new JSObject();
      ret.put("base64", Base64.encodeToString(data, Base64.NO_WRAP));
      ret.put("mimeType", outMime);
      ret.put("durationMs", System.currentTimeMillis() - startMs);
      call.resolve(ret);
    } catch (Exception e) {
      call.reject("read recording failed: " + e.getMessage());
    }
  }

  private void releaseRecorder() {
    if (recorder != null) {
      try {
        recorder.release();
      } catch (Exception ignored) {
        // ignore
      }
      recorder = null;
    }
  }

  private static byte[] readAll(File f) throws Exception {
    try (FileInputStream in = new FileInputStream(f);
        ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] buf = new byte[8192];
      int n;
      while ((n = in.read(buf)) != -1) {
        out.write(buf, 0, n);
      }
      return out.toByteArray();
    }
  }
}
