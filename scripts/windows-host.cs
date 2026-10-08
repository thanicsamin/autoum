using System;
using System.IO;
using System.Diagnostics;
using System.Threading.Tasks;
public class AutoumNativeHost {
  // Interactive native messages cannot wait in a FileStream write buffer.
  private static void Pump(Stream source, Stream destination) {
    byte[] buffer = new byte[81920];
    int count;
    while ((count = source.Read(buffer, 0, buffer.Length)) > 0) {
      destination.Write(buffer, 0, count);
      destination.Flush();
    }
  }
  public static int Main() {
    try {
      string[] config = File.ReadAllLines(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launch.txt"));
      var info = new ProcessStartInfo(config[0], "\"" + config[1] + "\"");
      info.UseShellExecute = false; info.CreateNoWindow = true;
      info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
      info.EnvironmentVariables["AUTOUM_DATA_DIR"] = config[2];
      if (config.Length > 3) info.EnvironmentVariables["AUTOUM_PROFILE_DIR"] = config[3];
      using (var child = Process.Start(info)) {
        var input = Task.Run(() => { Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); child.StandardInput.Close(); });
        var output = Task.Run(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()));
        var errors = Task.Run(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError()));
        child.WaitForExit(); output.Wait(); errors.Wait(); return child.ExitCode;
      }
    } catch { Console.Error.WriteLine("Autoum native host failed to launch. Run Setup again."); return 1; }
  }
}
