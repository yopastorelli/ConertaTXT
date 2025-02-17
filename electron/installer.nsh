!macro customInstall
  WriteRegStr HKCR ".txt" "" "ConvertaTXT.Document"
  WriteRegStr HKCR "ConvertaTXT.Document" "" "Documento de Texto ConvertaTXT"
  WriteRegStr HKCR "ConvertaTXT.Document\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCR "ConvertaTXT.Document\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCR ".txt"
  DeleteRegKey HKCR "ConvertaTXT.Document"
!macroend