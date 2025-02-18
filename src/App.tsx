import React, { useState, useCallback, useRef } from 'react';
import { Upload, Download, FileText, Settings2, Folder, Loader2 } from 'lucide-react';
import { createWorker } from 'tesseract.js';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist';
import * as xlsx from 'xlsx';
import PptxGenJS from 'pptxgenjs';

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

const allowedExtensions: { [key: string]: string[] } = {
  'application/msword': ['.doc', '.dot'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls', '.xlt'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-powerpoint': ['.ppt', '.pot', '.pps'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'application/pdf': ['.pdf'],
  'text/plain': ['.txt'],
  // Adicione mais tipos MIME e extensões permitidas conforme necessário
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

  const initializeWorker = async () => {
    if (!workerRef.current) {
      const worker = await createWorker();
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

  async function verifyFileType(file: File): Promise<boolean> {
    const fileExtension = file.name.split('.').pop()?.toLowerCase();
    const mimeTypes = Object.keys(allowedExtensions);
    const isValidExtension = mimeTypes.some(mime => allowedExtensions[mime].includes(`.${fileExtension}`));
    
    if (!isValidExtension) {
      console.warn(`File type mismatch for ${file.name}: expected ${file.type}`);
      return false;
    }
    return true;
  }

  const processFile = async (file: File): Promise<ProcessedFile | null> => {
    try {
      let content = '';
      const fileType = file.type;
      const filePath = file.webkitRelativePath || file.name;
      const fileSize = file.size;
      const fileDate = file.lastModified ? new Date(file.lastModified).toLocaleString() : 'N/A';

      console.log(`Processing file: ${file.name}, type: ${fileType}`);

      if (fileType.startsWith('text/')) {
        content = await file.text();
      } else if (fileType.startsWith('image/')) {
        content = await processImageFile(file);
      } else if (fileType === 'application/pdf') {
        const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
        const numPages = pdf.numPages;
        for (let i = 1; i <= numPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          const pageText = textContent.items.map((item: any) => item.str).join(' ');
          content += pageText + '\n';
        }
      } else if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || fileType === 'application/msword' || fileType === 'application/vnd.ms-word.document.macroEnabled.12') {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        content = result.value;
      } else if (fileType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || fileType === 'application/vnd.ms-excel' || fileType === 'application/vnd.ms-excel.sheet.macroEnabled.12') {
        const arrayBuffer = await file.arrayBuffer();
        const workbook = xlsx.read(arrayBuffer, { type: 'array' });
        workbook.SheetNames.forEach(sheetName => {
          const sheet = workbook.Sheets[sheetName];
          content += xlsx.utils.sheet_to_csv(sheet);
        });
      } else if (fileType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || fileType === 'application/vnd.ms-powerpoint' || fileType === 'application/vnd.ms-powerpoint.presentation.macroEnabled.12') {
        const arrayBuffer = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuffer);
        const pptxContent = await zip.file("ppt/slides/slide1.xml")?.async("string");
        if (pptxContent) {
          content = pptxContent;
        }
      } else if (fileType === 'application/vnd.lotus-freelance' || fileType === 'application/rtf') {
        const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
        content = result.value;
      } else {
        updateStats(false);
        logError(file.name, new Error('Unsupported file type'));
        return null;
      }

      updateStats(true);
      return {
        name: file.name,
        content: `Informações do Arquivo Original:\nCaminho: ${filePath}\nNome: ${file.name}\nData: ${fileDate}\nTamanho: ${fileSize} bytes\n\n${content}`,
        originalType: fileType,
        path: filePath
      };
    } catch (error) {
      console.error(`Error processing ${file.name}:`, error);
      updateStats(false);
      logError(file.name, error);
      return null;
    }
  };

  const processFileWithTimeout = async (file: File, timeout: number): Promise<ProcessedFile | null> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('File processing timed out'));
      }, timeout);

      processFile(file).then(result => {
        clearTimeout(timer);
        resolve(result);
      }).catch(error => {
        clearTimeout(timer);
        reject(error);
      });
    });
  };

  const handleFolderUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files?.length) return;

    console.log(`Selected ${files.length} files for processing`);

    // Create new abort controller
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setIsProcessing(true);
    setProcessingStatus('Scanning files...');
    setStats({ total: files.length, processed: 0, failed: 0 });
    
    const processedResults: ProcessedFile[] = [];
    const fileArray = Array.from(files);
    const batchSize = 5; // Process 5 files concurrently

    try {
      for (let i = 0; i < fileArray.length; i += batchSize) {
        const batch = fileArray.slice(i, i + batchSize);
        console.log(`Processing batch ${i / batchSize + 1} of ${Math.ceil(fileArray.length / batchSize)}`);
        const results = await Promise.all(batch.map(file => processFileWithTimeout(file, 30000).catch(error => {
          console.error(`Error processing ${file.name}:`, error);
          updateStats(false);
          logError(file.name, error);
          return null;
        })));
        processedResults.push(...results.filter(result => result !== null) as ProcessedFile[]);
        setProcessedFiles(processedResults);
        console.log(`Processed ${processedResults.length} files so far`);
      }
    } catch (error) {
      console.error('Error processing files:', error);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
      console.log('Finished processing all files');
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
      // Create a ZIP file containing all converted files
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
        
        // Preserve folder structure in ZIP
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
      // Download single file
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
                    accept=".txt,.doc,.docx,.pdf,.ppt,.pptx,.pez,.rtf,image/*"
                    onChange={handleFolderUpload}
                  />
                </label>
                <label className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 cursor-pointer">
                  <Folder className="h-4 w-4 mr-2" />
                  Upload Folder
                  <input
                    type="file"
                    className="hidden"
                    multiple
                    onChange={handleFolderUpload}
                    {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
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
                <option value="LF">LF</option>
                <option value="CRLF">CRLF</option>
                <option value="CR">CR</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700">Remove Empty Lines</label>
              <input
                type="checkbox"
                checked={options.removeEmptyLines}
                onChange={(e) => setOptions({ ...options, removeEmptyLines: e.target.checked })}
                className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700">Trim Whitespace</label>
              <input
                type="checkbox"
                checked={options.trimWhitespace}
                onChange={(e) => setOptions({ ...options, trimWhitespace: e.target.checked })}
                className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md"
              />
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

        <div className="mt-6 bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900">Error Logs</h2>
          <pre className="mt-4 p-4 bg-gray-100 rounded-md overflow-auto max-h-64">
            {errorLogs.join('')}
          </pre>
        </div>
      </main>
    </div>
  );
}

export default App;