package uk.benext.speak;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  private static final int REQ_MIC = 1001;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    // 必须在 super.onCreate 之前注册：Bridge 在 super.onCreate 里创建，
    // registerPlugin 只往 builder 里加，之后调用不会生效（曾导致
    // "MicPermission plugin is not implemented on android"）。
    registerPlugin(AudioRecorderPlugin.class);
    super.onCreate(savedInstanceState);
    // 首次启动即申请：Capacitor 不会自动弹系统授权，
    // 只在 Manifest 里声明时 WebView 的 getUserMedia 会直接被拒。
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(
          this, new String[] {Manifest.permission.RECORD_AUDIO}, REQ_MIC);
    }
  }
}
