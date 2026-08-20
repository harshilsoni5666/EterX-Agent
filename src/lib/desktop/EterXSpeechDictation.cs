using System;
using System.Globalization;
using System.Linq;
using System.Speech.Recognition;
using System.Text;

internal static class EterXSpeechDictation
{
    private static string JsonEscape(string value)
    {
        if (String.IsNullOrEmpty(value)) return String.Empty;
        var output = new StringBuilder(value.Length + 16);
        foreach (var character in value)
        {
            switch (character)
            {
                case '\\': output.Append("\\\\"); break;
                case '"': output.Append("\\\""); break;
                case '\n': output.Append("\\n"); break;
                case '\r': output.Append("\\r"); break;
                case '\t': output.Append("\\t"); break;
                default:
                    if (Char.IsControl(character)) output.AppendFormat("\\u{0:x4}", (int)character);
                    else output.Append(character);
                    break;
            }
        }
        return output.ToString();
    }

    private static void Emit(string type, string text, string code = "")
    {
        Console.WriteLine(
            "{\"type\":\"" + JsonEscape(type) +
            "\",\"text\":\"" + JsonEscape(text) +
            "\",\"code\":\"" + JsonEscape(code) + "\"}"
        );
        Console.Out.Flush();
    }

    private static RecognizerInfo SelectRecognizer(string requestedLanguage)
    {
        var recognizers = SpeechRecognitionEngine.InstalledRecognizers();
        if (recognizers.Count == 0) return null;

        CultureInfo requestedCulture = null;
        try
        {
            if (!String.IsNullOrWhiteSpace(requestedLanguage))
                requestedCulture = CultureInfo.GetCultureInfo(requestedLanguage);
        }
        catch (CultureNotFoundException) { }

        if (requestedCulture != null)
        {
            var exact = recognizers.FirstOrDefault(item =>
                String.Equals(item.Culture.Name, requestedCulture.Name, StringComparison.OrdinalIgnoreCase));
            if (exact != null) return exact;

            var sameLanguage = recognizers.FirstOrDefault(item =>
                String.Equals(item.Culture.TwoLetterISOLanguageName, requestedCulture.TwoLetterISOLanguageName, StringComparison.OrdinalIgnoreCase));
            if (sameLanguage != null) return sameLanguage;
        }

        return recognizers.FirstOrDefault(item =>
            String.Equals(item.Culture.Name, CultureInfo.CurrentUICulture.Name, StringComparison.OrdinalIgnoreCase))
            ?? recognizers[0];
    }

    public static int Main(string[] args)
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(false);
        var language = args.Length > 0 ? args[0] : String.Empty;
        var recognizerInfo = SelectRecognizer(language);
        if (recognizerInfo == null)
        {
            Emit("error", "Install a Windows speech language pack, then try voice dictation again.", "language-unavailable");
            return 2;
        }

        try
        {
            using (var recognizer = new SpeechRecognitionEngine(recognizerInfo))
            {
                recognizer.LoadGrammar(new DictationGrammar());
                recognizer.SpeechHypothesized += (_, eventArgs) =>
                    Emit("partial", eventArgs.Result == null ? String.Empty : eventArgs.Result.Text);
                recognizer.SpeechRecognized += (_, eventArgs) =>
                {
                    if (eventArgs.Result != null && eventArgs.Result.Confidence >= 0.12f)
                        Emit("final", eventArgs.Result.Text);
                };
                recognizer.RecognizeCompleted += (_, __) => Emit("stopped", String.Empty);
                recognizer.SetInputToDefaultAudioDevice();
                recognizer.RecognizeAsync(RecognizeMode.Multiple);
                Emit("ready", recognizerInfo.Culture.Name);

                // Electron closes stdin to stop dictation. No silence timeout is
                // used, so the recognizer remains active until the user clicks.
                Console.ReadLine();
                recognizer.RecognizeAsyncCancel();
                recognizer.RecognizeAsyncStop();
            }
            return 0;
        }
        catch (UnauthorizedAccessException)
        {
            Emit("error", "Windows blocked microphone access for EterX.", "not-allowed");
            return 3;
        }
        catch (InvalidOperationException error)
        {
            Emit("error", error.Message, "audio-capture");
            return 4;
        }
        catch (Exception error)
        {
            Emit("error", error.Message, "recognizer-failed");
            return 5;
        }
    }
}
