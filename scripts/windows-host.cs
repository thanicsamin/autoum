using System;
using System.IO;
using System.Diagnostics;
using System.Threading.Tasks;
public class AutoumNativeHost {
  public static int Main() {
    try {
      string[] config = File.ReadAllLines(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launch.txt"));
      var info = new ProcessStartInfo(config[0], "\"" + config[1] + "\"");
      info.UseShellExecute = false; info.CreateNoWindow = true;
      info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
      info.EnvironmentVariables["AUTOUM_DATA_DIR"] = config[2];
      if (config.Length > 3) info.EnvironmentVariables["AUTOUM_PROFILE_DIR"] = config[3];
      using (var child = Process.Start(info)) {
        var input = Task.Run(() => { Console.OpenStandardInput().CopyTo(child.StandardInput.BaseStream); child.StandardInput.Close(); });
        var output = Task.Run(() => child.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()));
        var errors = Task.Run(() => child.StandardError.BaseStream.CopyTo(Console.OpenStandardError()));
        child.WaitForExit(); output.Wait(); errors.Wait(); return child.ExitCode;
      }
    } catch { Console.Error.WriteLine("Autoum native host failed to launch. Run Setup again."); return 1; }
  }
}
