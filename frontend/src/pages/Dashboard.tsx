import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ServiceCard } from '@/components/ServiceCard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
// import { cn } from '@/lib/utils';

export function Dashboard() {
  const {
    data: servicesData,
    isLoading: servicesLoading,
    isError: servicesError,
    refetch: refetchServices,
  } = useQuery({
    queryKey: ['services'],
    queryFn: api.getServices,
  });

  useEffect(() => {
    const timer = setInterval(() => {
      void refetchServices();
    }, 30_000);

    return () => clearInterval(timer);
  }, [refetchServices]);

  const services = useMemo(() => servicesData?.services ?? [], [servicesData]);

  // const hasServiceDisruption = services.some((service) => service.currentStatus !== 'ok');
  // const globalStatusText = hasServiceDisruption ? 'Some Systems Down' : 'All Systems Operational';
  // const globalStatusClass = hasServiceDisruption ? 'bg-red-500' : 'bg-green-500';

  if (servicesLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-8 text-sm text-gray-500">
        正在加载服务状态...
      </div>
    );
  }

  if (servicesError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-8">
        <Card className="max-w-md border border-red-100 bg-white shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg font-semibold text-gray-900">加载失败</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-gray-600">
            <p className="text-sm">
              服务列表加载失败，请稍后重试
            </p>
            <Button
              className="bg-red-500 text-white hover:bg-red-600"
              onClick={() => void refetchServices()}
            >
              重试
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8 pb-96">
      <div className="mx-auto max-w-5xl space-y-8">
        <div className="space-y-3">
          <h1 className="text-4xl font-bold text-gray-900">AI CLI Provider健康状态检测</h1>
          <p className="text-base text-gray-600">仅供参考</p>
        </div>

        {/* <div className={cn('rounded-lg px-6 py-4 text-white', globalStatusClass)}>
          <p className="text-xl font-semibold">{globalStatusText}</p>
        </div> */}

        <div className="space-y-4">
          {services.map((service) => (
            <ServiceCard key={service.id} service={service} />
          ))}
        </div>
      </div>
    </div>
  );
}
