import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button, Modal } from "./UI";

type Request = { message: string; resolve: (accepted: boolean) => void };
const ConfirmationContext = createContext<
  (message: string) => Promise<boolean>
>(() => Promise.resolve(false));

export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [requests, setRequests] = useState<Request[]>([]);
  const pending = useRef(requests);
  pending.current = requests;
  const confirm = useCallback(
    (message: string) =>
      new Promise<boolean>((resolve) => {
        setRequests((queue) => [...queue, { message, resolve }]);
      }),
    [],
  );
  useEffect(
    () => () => pending.current.forEach((request) => request.resolve(false)),
    [],
  );
  const finish = (accepted: boolean) => {
    requests[0]?.resolve(accepted);
    setRequests((queue) => queue.slice(1));
  };
  return (
    <ConfirmationContext.Provider value={confirm}>
      {children}
      {requests[0] && (
        <Modal title="Conferma operazione" onClose={() => finish(false)}>
          <div className="modal-body">
            <p>{requests[0].message}</p>
          </div>
          <footer>
            <Button data-autofocus onClick={() => finish(false)}>
              Annulla
            </Button>
            <span className="spacer" />
            <Button variant="primary" onClick={() => finish(true)}>
              Conferma
            </Button>
          </footer>
        </Modal>
      )}
    </ConfirmationContext.Provider>
  );
}

export function useConfirmation() {
  return useContext(ConfirmationContext);
}
