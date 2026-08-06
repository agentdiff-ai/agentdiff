using System.Diagnostics;
using System.Text.Json;
using NAudio.Wave;

Exception? failure = null;
var staThread = new Thread(() =>
{
    try
    {
        Run(args).GetAwaiter().GetResult();
    }
    catch (Exception exception)
    {
        failure = exception;
    }
});
staThread.SetApartmentState(ApartmentState.STA);
staThread.Start();
staThread.Join();

if (failure is not null)
{
    Console.ForegroundColor = ConsoleColor.Red;
    Console.Error.WriteLine($"Recorder failed: {failure.Message}");
    Console.ResetColor();
    Environment.ExitCode = 1;
}

static async Task Run(string[] args)
{
    var options = RecorderOptions.Parse(args);
    if (options.ListDrivers)
    {
        ListDrivers();
        return;
    }
    if (options.ListInputs)
    {
        ListInputs(options.Driver);
        return;
    }

    var repoRoot = FindRepoRoot();
    var specPath = Path.GetFullPath(Path.Combine(repoRoot, options.SpecPath));
    var spec = LoadSpec(specPath);
    var scenes = spec.Render?.Scenes ?? throw new InvalidOperationException("Demo spec does not define render.scenes.");
    if (scenes.Count == 0) throw new InvalidOperationException("Demo spec has no recording scenes.");

    var outputDirectory = Path.Combine(
        repoRoot,
        ".agentdiff",
        "demos",
        spec.Id,
        "final",
        "voiceover-human-segments");
    Directory.CreateDirectory(outputDirectory);

    using var recorder = new AsioRecorder(options.Driver, options.SampleRate, options.InputChannel);
    PrintHeader(spec, recorder, outputDirectory);

    if (options.LevelCheck)
    {
        await RunLevelCheck(recorder, options.LevelCheckSeconds);
        return;
    }

    foreach (var scene in scenes)
    {
        var outputPath = Path.Combine(outputDirectory, $"{scene.Id}.wav");
        var complete = await RecordScene(recorder, scene, outputPath);
        if (!complete)
        {
            Console.WriteLine("\nRecording session stopped. Existing accepted takes were kept.");
            return;
        }
    }

    Console.ForegroundColor = ConsoleColor.Green;
    Console.WriteLine("\nAll six scene recordings are ready.");
    Console.ResetColor();
    Console.WriteLine("Render the final video with:");
    Console.WriteLine("  npm run demo:video");
}

static async Task<bool> RecordScene(AsioRecorder recorder, DemoScene scene, string outputPath)
{
    while (true)
    {
        Console.Clear();
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine($"{scene.Id}  |  target: {scene.DurationSeconds:0.#}s");
        Console.ResetColor();
        Console.WriteLine(new string('-', 72));
        Console.WriteLine(Wrap(scene.Voiceover, 72));
        Console.WriteLine(new string('-', 72));

        if (File.Exists(outputPath))
        {
            Console.WriteLine("Existing take found: [P] play  [K] keep  [R] replace  [Q] quit");
            var existingChoice = ReadChoice('p', 'k', 'r', 'q');
            if (existingChoice == 'p')
            {
                await Play(outputPath);
                continue;
            }
            if (existingChoice == 'k') return true;
            if (existingChoice == 'q') return false;
        }
        else
        {
            Console.WriteLine("[Enter] record  [Q] quit");
            var key = Console.ReadKey(intercept: true);
            if (key.Key == ConsoleKey.Q) return false;
            if (key.Key != ConsoleKey.Enter) continue;
        }

        await Countdown();
        Console.WriteLine("RECORDING - press Enter to stop early");
        var result = await recorder.Record(outputPath, TimeSpan.FromSeconds(scene.DurationSeconds));
        PrintTakeResult(result, scene.DurationSeconds);

        Console.WriteLine("[Enter] accept  [P] play  [R] retake  [Q] quit");
        while (true)
        {
            var choice = Console.ReadKey(intercept: true);
            if (choice.Key == ConsoleKey.Enter) return true;
            if (choice.Key == ConsoleKey.P)
            {
                await Play(outputPath);
                Console.WriteLine("[Enter] accept  [P] play  [R] retake  [Q] quit");
                continue;
            }
            if (choice.Key == ConsoleKey.R) break;
            if (choice.Key == ConsoleKey.Q) return false;
        }
    }
}

static async Task RunLevelCheck(AsioRecorder recorder, int seconds)
{
    var temporary = Path.Combine(Path.GetTempPath(), $"agentdiff-level-check-{Guid.NewGuid():N}.wav");
    Console.WriteLine($"Speak normally for {seconds} seconds. This test file will be deleted.");
    await Countdown();
    var result = await recorder.Record(temporary, TimeSpan.FromSeconds(seconds));
    PrintTakeResult(result, seconds);
    File.Delete(temporary);
    Console.WriteLine("Level check complete.");
}

static void PrintTakeResult(RecordingResult result, double targetSeconds)
{
    Console.WriteLine();
    Console.WriteLine($"Recorded: {result.Duration.TotalSeconds:0.00}s / {targetSeconds:0.0}s");
    Console.WriteLine($"Peak:     {result.PeakDbFs:0.0} dBFS");
    Console.WriteLine($"Average:  {result.RmsDbFs:0.0} dBFS");
    if (result.PeakDbFs > -1.0)
    {
        Console.ForegroundColor = ConsoleColor.Red;
        Console.WriteLine("Level warning: clipping risk. Lower the Apollo preamp gain.");
    }
    else if (result.PeakDbFs < -24.0)
    {
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine("Level warning: quiet take. Raise the Apollo preamp gain or move closer.");
    }
    else
    {
        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine("Level is usable. A voice peak around -12 to -6 dBFS is ideal.");
    }
    Console.ResetColor();
}

static async Task Countdown()
{
    for (var count = 3; count >= 1; count--)
    {
        Console.Write($"\rRecording in {count}... ");
        await Task.Delay(700);
    }
    Console.WriteLine("\rRecording now.    ");
}

static async Task Play(string path)
{
    using var reader = new AudioFileReader(path);
    using var output = new WaveOutEvent();
    var finished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    output.PlaybackStopped += (_, _) => finished.TrySetResult();
    output.Init(reader);
    output.Play();
    Console.WriteLine("Playing take...");
    await finished.Task;
}

static char ReadChoice(params char[] choices)
{
    while (true)
    {
        var key = char.ToLowerInvariant(Console.ReadKey(intercept: true).KeyChar);
        if (choices.Contains(key)) return key;
    }
}

static void ListDrivers()
{
    var drivers = AsioOut.GetDriverNames();
    if (drivers.Length == 0)
    {
        Console.WriteLine("No ASIO drivers were found.");
        return;
    }
    Console.WriteLine("Available ASIO drivers:");
    foreach (var driver in drivers) Console.WriteLine($"- {driver}");
}

static void ListInputs(string driverName)
{
    using var asio = new AsioOut(driverName);
    Console.WriteLine($"Input channels for {driverName}:");
    for (var index = 0; index < asio.DriverInputChannelCount; index++)
        Console.WriteLine($"{index + 1,2}: {asio.AsioInputChannelName(index)}");
}

static void PrintHeader(DemoSpec spec, AsioRecorder recorder, string outputDirectory)
{
    Console.WriteLine("Agentdiff demo voice recorder");
    Console.WriteLine($"Demo:        {spec.Id}");
    Console.WriteLine($"ASIO driver: {recorder.DriverName}");
    Console.WriteLine($"Input:       {recorder.InputChannelNumber} - {recorder.InputChannelName}");
    Console.WriteLine($"Format:      {recorder.SampleRate} Hz, 24-bit mono PCM WAV");
    Console.WriteLine($"Output:      {outputDirectory}");
    Console.WriteLine();
}

static DemoSpec LoadSpec(string path)
{
    if (!File.Exists(path)) throw new FileNotFoundException("Demo spec was not found.", path);
    var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
    return JsonSerializer.Deserialize<DemoSpec>(File.ReadAllText(path), options)
        ?? throw new InvalidOperationException($"Could not parse demo spec: {path}");
}

static string FindRepoRoot()
{
    var current = new DirectoryInfo(Environment.CurrentDirectory);
    while (current is not null)
    {
        if (File.Exists(Path.Combine(current.FullName, "package.json")) && Directory.Exists(Path.Combine(current.FullName, "demos")))
            return current.FullName;
        current = current.Parent;
    }
    throw new InvalidOperationException("Run this command from the agentdiff repository.");
}

static string Wrap(string text, int width)
{
    var words = text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
    var lines = new List<string>();
    var line = "";
    foreach (var word in words)
    {
        if (line.Length > 0 && line.Length + 1 + word.Length > width)
        {
            lines.Add(line);
            line = word;
        }
        else
        {
            line = line.Length == 0 ? word : $"{line} {word}";
        }
    }
    if (line.Length > 0) lines.Add(line);
    return string.Join(Environment.NewLine, lines);
}

sealed class AsioRecorder : IDisposable
{
    private readonly AsioOut asio;
    private readonly object sync = new();
    private WaveFileWriter? writer;
    private long sampleCount;
    private double squareSum;
    private float peak;
    private float meterPeak;
    private float[]? sampleBuffer;

    public string DriverName { get; }
    public int SampleRate { get; }
    public int InputChannelNumber { get; }
    public string InputChannelName { get; }

    public AsioRecorder(string driverName, int sampleRate, int inputChannelNumber)
    {
        var drivers = AsioOut.GetDriverNames();
        var matchedDriver = drivers.FirstOrDefault(driver => string.Equals(driver, driverName, StringComparison.OrdinalIgnoreCase));
        if (matchedDriver is null)
            throw new InvalidOperationException($"ASIO driver '{driverName}' was not found. Available: {string.Join(", ", drivers)}");

        DriverName = matchedDriver;
        SampleRate = sampleRate;
        InputChannelNumber = inputChannelNumber;
        asio = new AsioOut(matchedDriver);
        if (inputChannelNumber < 1 || inputChannelNumber > asio.DriverInputChannelCount)
            throw new ArgumentOutOfRangeException(nameof(inputChannelNumber), $"Input channel must be between 1 and {asio.DriverInputChannelCount}.");

        InputChannelName = asio.AsioInputChannelName(inputChannelNumber - 1);
        asio.InputChannelOffset = inputChannelNumber - 1;
        asio.AudioAvailable += OnAudioAvailable;
        asio.InitRecordAndPlayback(null, 1, sampleRate);
    }

    public async Task<RecordingResult> Record(string path, TimeSpan maximumDuration)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        lock (sync)
        {
            writer?.Dispose();
            writer = new WaveFileWriter(path, new WaveFormat(SampleRate, 24, 1));
            sampleCount = 0;
            squareSum = 0;
            peak = 0;
            meterPeak = 0;
        }

        var stopwatch = Stopwatch.StartNew();
        asio.Play();
        try
        {
            while (stopwatch.Elapsed < maximumDuration)
            {
                if (!Console.IsInputRedirected && Console.KeyAvailable && Console.ReadKey(intercept: true).Key == ConsoleKey.Enter) break;
                RenderMeter(stopwatch.Elapsed, maximumDuration);
                await Task.Delay(75);
            }
        }
        finally
        {
            asio.Stop();
            stopwatch.Stop();
            Console.Write("\r" + new string(' ', 78) + "\r");
        }

        long samples;
        double sum;
        float maximum;
        lock (sync)
        {
            writer?.Dispose();
            writer = null;
            samples = sampleCount;
            sum = squareSum;
            maximum = peak;
        }

        var duration = TimeSpan.FromSeconds(samples / (double)SampleRate);
        var rms = samples > 0 ? Math.Sqrt(sum / samples) : 0;
        return new RecordingResult(duration, ToDb(maximum), ToDb(rms));
    }

    private void OnAudioAvailable(object? sender, AsioAudioAvailableEventArgs e)
    {
        sampleBuffer ??= new float[e.SamplesPerBuffer];
        if (sampleBuffer.Length != e.SamplesPerBuffer) sampleBuffer = new float[e.SamplesPerBuffer];
        e.GetAsInterleavedSamples(sampleBuffer);
        var samples = sampleBuffer;
        lock (sync)
        {
            if (writer is null) return;
            writer.WriteSamples(samples, 0, samples.Length);
            var bufferPeak = 0f;
            foreach (var sample in samples)
            {
                var absolute = Math.Abs(sample);
                if (absolute > bufferPeak) bufferPeak = absolute;
                if (absolute > peak) peak = absolute;
                squareSum += sample * sample;
            }
            meterPeak = bufferPeak;
            sampleCount += samples.Length;
        }
        e.WrittenToOutputBuffers = true;
    }

    private void RenderMeter(TimeSpan elapsed, TimeSpan maximum)
    {
        float currentPeak;
        lock (sync) currentPeak = meterPeak;
        var db = ToDb(currentPeak);
        var normalized = Math.Clamp((db + 48) / 48, 0, 1);
        var bars = (int)Math.Round(normalized * 32);
        Console.Write($"\r{elapsed.TotalSeconds,5:0.0}/{maximum.TotalSeconds:0.0}s  [{new string('#', bars)}{new string('-', 32 - bars)}] {db,6:0.0} dBFS");
    }

    private static double ToDb(double amplitude) => amplitude <= 0 ? -96 : 20 * Math.Log10(amplitude);

    public void Dispose()
    {
        lock (sync)
        {
            writer?.Dispose();
            writer = null;
        }
        asio.Dispose();
    }
}

sealed record RecordingResult(TimeSpan Duration, double PeakDbFs, double RmsDbFs);

sealed class RecorderOptions
{
    public string SpecPath { get; init; } = RecorderDefaults.Spec;
    public string Driver { get; init; } = RecorderDefaults.Driver;
    public int SampleRate { get; init; } = RecorderDefaults.SampleRate;
    public int InputChannel { get; init; } = 1;
    public bool ListDrivers { get; init; }
    public bool ListInputs { get; init; }
    public bool LevelCheck { get; init; }
    public int LevelCheckSeconds { get; init; } = 5;

    public static RecorderOptions Parse(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var switches = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Length; index++)
        {
            var arg = args[index];
            if (!arg.StartsWith("--")) continue;
            if (index + 1 < args.Length && !args[index + 1].StartsWith("--")) values[arg] = args[++index];
            else switches.Add(arg);
        }

        return new RecorderOptions
        {
            SpecPath = values.GetValueOrDefault("--spec", RecorderDefaults.Spec),
            Driver = values.GetValueOrDefault("--driver", RecorderDefaults.Driver),
            SampleRate = ParsePositive(values, "--sample-rate", RecorderDefaults.SampleRate),
            InputChannel = ParsePositive(values, "--input-channel", 1),
            ListDrivers = switches.Contains("--list-drivers"),
            ListInputs = switches.Contains("--list-inputs"),
            LevelCheck = switches.Contains("--level-check"),
            LevelCheckSeconds = ParsePositive(values, "--seconds", 5)
        };
    }

    private static int ParsePositive(IReadOnlyDictionary<string, string> values, string key, int fallback)
    {
        if (!values.TryGetValue(key, out var raw)) return fallback;
        if (!int.TryParse(raw, out var parsed) || parsed <= 0) throw new ArgumentException($"{key} must be a positive integer.");
        return parsed;
    }
}

static class RecorderDefaults
{
    public const string Spec = "demos/refund-support-boundary.json";
    public const string Driver = "Universal Audio Thunderbolt";
    public const int SampleRate = 48_000;
}

sealed class DemoSpec
{
    public required string Id { get; init; }
    public DemoRender? Render { get; init; }
}

sealed class DemoRender
{
    public List<DemoScene>? Scenes { get; init; }
}

sealed class DemoScene
{
    public required string Id { get; init; }
    public required string Voiceover { get; init; }
    public double DurationSeconds { get; init; }
}
