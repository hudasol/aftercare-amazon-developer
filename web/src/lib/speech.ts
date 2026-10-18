/**
 * Voice on the assistant surface, using the browser's Web Speech API when it
 * exists. Voice is optional; typing always works.
 */

export function canSpeak(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function speak(text: string): void {
  if (!canSpeak()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.02;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.cancel();
}

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

type RecognitionConstructor = new () => RecognitionLike;

function recognitionConstructor(): RecognitionConstructor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function canListen(): boolean {
  return typeof window !== 'undefined' && recognitionConstructor() !== null;
}

/** Listen for one utterance. Returns a function that stops listening. */
export function listen(handlers: {
  onText: (text: string) => void;
  onEnd: () => void;
  onError: (message: string) => void;
}): () => void {
  const Ctor = recognitionConstructor();
  if (!Ctor) {
    handlers.onError('Voice input is not available in this browser.');
    handlers.onEnd();
    return () => undefined;
  }
  const recognition = new Ctor();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = (event) => {
    const text = event.results[0]?.[0]?.transcript ?? '';
    if (text) handlers.onText(text);
  };
  recognition.onerror = (event) =>
    handlers.onError(
      event.error === 'not-allowed' ? 'Microphone access was blocked.' : 'Voice input stopped.',
    );
  recognition.onend = handlers.onEnd;
  recognition.start();
  return () => recognition.stop();
}
