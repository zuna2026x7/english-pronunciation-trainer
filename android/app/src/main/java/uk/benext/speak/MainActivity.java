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
    super.onCreate(savedInstanceState);
    // 供 JS 在每次录音前调用，处理用户上次拒绝后再次申请的情况
    registerPlugin(MicPermissionPlugin.class);
    // 首次启动即申请：Capacitor 不会自动弹系统授权，
    // 只在 Manifest 里声明时 WebView 的 getUserMedia 会直接被拒。
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(
          this, new String[] {Manifest.permission.RECORD_AUDIO}, REQ_MIC);
    }
  }
}
