import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Upload, Download, FileText, Settings2, Folder, Loader2 } from 'lucide-react';
import { createWorker } from 'tesseract.js';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist';
import * as xlsx from 'xlsx';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.10.377/pdf.worker.min.js';

type ConversionOptions = {
  encoding: string;
  lineEnding: string;
  removeEmptyLines: boolean;
  trimWhitespace: boolean;
};

type ProcessedFile = {
  name: string;
  content: string;
  originalType: string;
  path: string;
};

type ProcessingStats = {
  total: number;
  processed: number;
  failed: number;
};

const processOfficeFile = async (file: File): Promise<string> => {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const arrayBuffer = await file.arrayBuffer();

  switch (extension) {
    case 'doc':
    case 'docx':
      try {
        const result = await mammoth.extractRawText({ arrayBuffer });
        return result.value;
      } catch (error) {
        console.error('Error processing Word file:', error);
        throw error;
      }
    case 'xls':
    case 'xlsx':
      try {
        const workbook = xlsx.read(arrayBuffer, { type: 'array' });
        let content = '';
        workbook.SheetNames.forEach(sheetName => {
          const sheet = workbook.Sheets[sheetName];
          content += `Sheet: ${sheetName}\n`;
          content += xlsx.utils.sheet_to_csv(sheet);
          content += '\n\n';
        });
        return content;
      } catch (error) {
        console.error('Error processing Excel file:', error);
        throw error;
      }
    case 'ppt':
    case 'pptx':
      try {
        const zip = await JSZip.loadAsync(arrayBuffer);
        let content = '';
        const slideFiles = Object.keys(zip.files).filter(name => 
          name.startsWith('ppt/slides/slide') && name.endsWith('.xml')
        );
        
        for (const slideFile of slideFiles) {
          const slideContent = await zip.file(slideFile)?.async('string');
          if (slideContent) {
            // Extract text from XML
            const textMatches = slideContent.match(/>([^<]+)</g);
            if (textMatches) {
              content += `Slide ${slideFile.match(/\d+/)?.[0] || ''}\n`;
              content += textMatches
                .map(match => match.slice(1, -1).trim())
                .filter(text => text.length > 0)
                .join('\n');
              content += '\n\n';
            }
          }
        }
        return content;
      } catch (error) {
        console.error('Error processing PowerPoint file:', error);
        throw error;
      }
    default:
      throw new Error(`Unsupported office file extension: ${extension}`);
  }
};

function App() {
  const [inputText, setInputText] = useState('');
  const [outputText, setOutputText] = useState('');
  const [options, setOptions] = useState<ConversionOptions>({
    encoding: 'UTF-8',
    lineEnding: 'LF',
    removeEmptyLines: false,
    trimWhitespace: false,
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [processedFiles, setProcessedFiles] = useState<ProcessedFile[]>([]);
  const [processingStatus, setProcessingStatus] = useState('');
  const [stats, setStats] = useState<ProcessingStats>({ total: 0, processed: 0, failed: 0 });
  const [errorLogs, setErrorLogs] = useState<string[]>([]);
  const workerRef = useRef<any>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute('webkitdirectory', 'true');
      folderInputRef.current.setAttribute('directory', 'true');
    }
  }, []);

  const initializeWorker = async () => {
    if (!workerRef.current) {
      const worker = await createWorker();
      await worker.load();
      await worker.reinitialize('eng');
      workerRef.current = worker;
    }
    return workerRef.current;
  };

  const processImageFile = async (file: File): Promise<string> => {
    const worker = await initializeWorker();
    const { data: { text } } = await worker.recognize(file);
    return text;
  };

  const updateStats = (success: boolean) => {
    setStats(prev => ({
      ...prev,
      processed: prev.processed + 1,
      failed: prev.failed + (success ? 0 : 1),
    }));
  };

  const logError = (fileName: string, error: any) => {
    const logMessage = `Error processing ${fileName}: ${error.message}\n`;
    setErrorLogs(prevLogs => [...prevLogs, logMessage]);
  };

  const processFile = async (file: File): Promise<ProcessedFile | null> => {
    try {
      let content = '';
      const extension = file.name.split('.').pop()?.toLowerCase();
      const filePath = file.webkitRelativePath || file.name;
      const fileSize = file.size;
      const fileDate = file.lastModified ? new Date(file.lastModified).toLocaleString() : 'N/A';

      console.log(`Processing file: ${file.name}, extension: ${extension}`);

      if (file.type.startsWith('text/')) {
        content = await file.text();
      } else if (file.type.startsWith('image/')) {
        content = await processImageFile(file);
      } else if (file.type === 'application/pdf' || extension === 'pdf') {
        const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
        const numPages = pdf.numPages;
        for (let i = 1; i <= numPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          const pageText = textContent.items.map((item: any) => item.str).join(' ');
          content += `Page ${i}\n${pageText}\n\n`;
        }
      } else if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(extension || '')) {
        content = await processOfficeFile(file);
      } else {
        updateStats(false);
        logError(file.name, new Error('Unsupported file type'));
        return null;
      }

      updateStats(true);
      return {
        name: file.name,
        content: `File Information:\nPath: ${filePath}\nName: ${file.name}\nDate: ${fileDate}\nSize: ${fileSize} bytes\n\nContent:\n${content}`,
        originalType: extension || 'unknown',
        path: filePath
      };
    } catch (error) {
      console.error(`Error processing ${file.name}:`, error);
      updateStats(false);
      logError(file.name, error);
      return null;
    }
  };

  const handleFolderUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files?.length) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setIsProcessing(true);
    setProcessingStatus('Scanning files...');
    setStats({ total: files.length, processed: 0, failed: 0 });
    setErrorLogs([]);
    
    const processedResults: ProcessedFile[] = [];
    const fileArray = Array.from(files);
    const batchSize = 5;

    try {
      for (let i = 0; i < fileArray.length; i += batchSize) {
        if (abortControllerRef.current?.signal.aborted) {
          throw new Error('Processing cancelled');
        }

        const batch = fileArray.slice(i, i + batchSize);
        const batchPromises = batch.map(file => {
          setProcessingStatus(`Processing ${file.name} (${i + 1}/${files.length})`);
          return processFile(file);
        });

        const results = await Promise.all(batchPromises);
        const validResults = results.filter((result): result is ProcessedFile => result !== null);
        processedResults.push(...validResults);
        setProcessedFiles(processedResults);

        const progress = Math.min(((i + batch.length) / files.length) * 100, 100);
        setProcessingStatus(`Processed ${i + batch.length} of ${files.length} files (${progress.toFixed(1)}%)`);
      }

      // Combine all processed content
      const combinedText = processedResults
        .map(file => `=== ${file.path} ===\n${file.content}\n`)
        .join('\n');
      setInputText(combinedText);
    } catch (error) {
      if (error instanceof Error && error.message === 'Processing cancelled') {
        setProcessingStatus('Processing cancelled');
      } else {
        console.error('Error processing files:', error);
        setProcessingStatus('Error processing files');
      }
    } finally {
      setIsProcessing(false);
      abortControllerRef.current = null;
    }
  }, []);

  const handleCancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  const handleConvert = useCallback(() => {
    let converted = inputText;

    if (options.trimWhitespace) {
      converted = converted.split('\n').map(line => line.trim()).join('\n');
    }

    if (options.removeEmptyLines) {
      converted = converted.split('\n').filter(line => line.trim().length > 0).join('\n');
    }

    if (options.lineEnding === 'CRLF') {
      converted = converted.replace(/\n/g, '\r\n');
    } else if (options.lineEnding === 'CR') {
      converted = converted.replace(/\n/g, '\r');
    }

    setOutputText(converted);
  }, [inputText, options]);

  const handleDownload = useCallback(async () => {
    if (processedFiles.length > 1) {
      const zip = new JSZip();
      
      processedFiles.forEach(file => {
        let converted = file.content;
        if (options.trimWhitespace) {
          converted = converted.split('\n').map(line => line.trim()).join('\n');
        }
        if (options.removeEmptyLines) {
          converted = converted.split('\n').filter(line => line.trim().length > 0).join('\n');
        }
        if (options.lineEnding === 'CRLF') {
          converted = converted.replace(/\n/g, '\r\n');
        } else if (options.lineEnding === 'CR') {
          converted = converted.replace(/\n/g, '\r');
        }
        
        const fileName = file.path.replace(/\.[^/.]+$/, '') + '.txt';
        zip.file(fileName, converted);
      });

      const content = await zip.generateAsync({ 
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: {
          level: 9
        }
      });
      
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'converted_files.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else {
      const blob = new Blob([outputText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'converted.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }, [outputText, processedFiles, options]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8 flex items-center">
          <FileText className="h-8 w-8 text-indigo-600" />
          <h1 className="ml-3 text-2xl font-bold text-gray-900">ConvertaTXT</h1>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Input Section */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Input</h2>
              <div className="flex gap-2">
                <label className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 cursor-pointer">
                  <Upload className="h-4 w-4 mr-2" />
                  Upload File
                  <input
                    type="file"
                    className="hidden"
                    accept=".txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.pdf,.rtf,image/*"
                    onChange={handleFolderUpload}
                  />
                </label>
                <label className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 cursor-pointer">
                  <Folder className="h-4 w-4 mr-2" />
                  Upload Folder
                  <input
                    type="file"
                    className="hidden"
                    ref={folderInputRef}
                    multiple
                    onChange={handleFolderUpload as any}
                  />
                </label>
              </div>
            </div>
            {isProcessing ? (
              <div className="flex flex-col items-center justify-center h-96">
                <Loader2 className="h-8 w-8 text-indigo-600 animate-spin mb-4" />
                <p className="text-gray-600 mb-2">{processingStatus}</p>
                <div className="w-full max-w-md bg-gray-200 rounded-full h-2.5 mb-4">
                  <div 
                    className="bg-indigo-600 h-2.5 rounded-full transition-all duration-300" 
                    style={{ width: `${(stats.processed / stats.total) * 100}%` }}
                  ></div>
                </div>
                <div className="text-sm text-gray-500">
                  Processed: {stats.processed} / {stats.total}
                  {stats.failed > 0 && ` (Failed: ${stats.failed})`}
                </div>
                <button
                  onClick={handleCancel}
                  className="mt-4 px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                className="w-full h-96 p-3 border border-gray-300 rounded-md focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="Paste your text here or upload files..."
              />
            )}
          </div>

          {/* Output Section */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Output</h2>
              <button
                onClick={handleDownload}
                disabled={!outputText && processedFiles.length === 0}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                <Download className="h-4 w-4 mr-2" />
                {processedFiles.length > 1 ? 'Download ZIP' : 'Download'}
              </button>
            </div>
            <textarea
              value={outputText}
              readOnly
              className="w-full h-96 p-3 border border-gray-300 rounded-md bg-gray-50"
              placeholder="Converted text will appear here..."
            />
          </div>
        </div>

        {/* Options Panel */}
        <div className="mt-6 bg-white rounded-lg shadow p-6">
          <div className="flex items-center mb-4">
            <Settings2 className="h-5 w-5 text-indigo-600 mr-2" />
            <h2 className="text-lg font-semibold text-gray-900">Options</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Encoding</label>
              <select
                value={options.encoding}
                onChange={(e) => setOptions({ ...options, encoding: e.target.value })}
                className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md"
              >
                <option value="UTF-8">UTF-8</option>
                <option value="ISO-8859-1">ISO-8859-1</option>
                <option value="Windows-1252">Windows-1252</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Line Ending</label>
              <select
                value={options.lineEnding}
                onChange={(e) => setOptions({ ...options, lineEnding: e.target.value })}
                className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md"
              >
                <option value="LF">LF (Unix)</option>
                <option value="CRLF">CRLF (Windows)</option>
                <option value="CR">CR (Mac)</option>
              </select>
            </div>
            <div className="flex items-center">
              <input
                type="checkbox"
                id="removeEmptyLines"
                checked={options.removeEmptyLines}
                onChange={(e) => setOptions({ ...options, removeEmptyLines: e.target.checked })}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
              />
              <label htmlFor="removeEmptyLines" className="ml-2 block text-sm text-gray-900">
                Remove Empty Lines
              </label>
            </div>
            <div className="flex items-center">
              <input
                type="checkbox"
                id="trimWhitespace"
                checked={options.trimWhitespace}
                onChange={(e) => setOptions({ ...options, trimWhitespace: e.target.checked })}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
              />
              <label htmlFor="trimWhitespace" className="ml-2 block text-sm text-gray-900">
                Trim Whitespace
              </label>
            </div>
          </div>
          <div className="mt-4">
            <button
              onClick={handleConvert}
              disabled={!inputText}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              Convert Text
            </button>
          </div>
        </div>

        {/* Error Logs */}
        {errorLogs.length > 0 && (
          <div className="mt-6 bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Error Logs</h2>
            <pre className="mt-2 p-4 bg-gray-100 rounded-md overflow-auto max-h-64 text-sm">
              {errorLogs.join('')}
            </pre>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;